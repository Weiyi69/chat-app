import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";

import { env } from "../config/env.js";
import { requireAuthentication } from "../middleware/authenticate.js";
import { Conversation } from "../models/conversation.js";
import { User } from "../models/user.js";
import { objectIdSchema } from "../validators/common.js";
import { createOrFindConversation } from "../services/conversations.js";
import {
  AvatarRequestError,
  avatarUrlFor,
  deleteAvatarIfUnreferenced,
  processAvatar,
  readAvatar,
  writeAvatar,
} from "../services/avatars.js";
import { ChatRequestError } from "../services/chat-errors.js";
import {
  addGroupMembers,
  createGroup,
  findGroupForMember,
  leaveGroup,
  renameGroup,
  removeGroupPhoto,
  removeGroupMember,
  replaceGroupPhoto,
  requireGroupAdmin,
  serializeGroup,
} from "../services/groups.js";
import { publishGroupUpdate } from "../sockets/realtime.js";
import {
  addGroupMembersSchema,
  createConversationSchema,
  createGroupSchema,
  renameGroupSchema,
} from "../validators/conversations.js";

export const conversationsRouter = Router();

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const groupPhotoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const groupPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.AVATAR_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 0,
    parts: 1,
  },
});

conversationsRouter.use(requireAuthentication);

async function requireGroupPhotoAdmin(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  const groupId = objectIdSchema.parse(request.params.groupId);
  await requireGroupAdmin(groupId, request.session.userId!);
  next();
}

async function discardUnreferencedGroupPhoto(key: string) {
  try {
    await deleteAvatarIfUnreferenced(key);
  } catch (error) {
    console.error("Failed group photo upload cleanup failed", error instanceof Error ? error.name : "UnknownError");
  }
}

conversationsRouter.get("/", async (request, response) => {
  const userId = request.session.userId!;
  const conversations = await Conversation.find({ participants: userId })
    .where({ archivedAt: null })
    .sort({ lastActivityAt: -1, _id: -1 })
    .limit(50)
    .lean();
  const userIds = conversations.flatMap((conversation) =>
    conversation.kind === "group"
      ? conversation.participants.map((id) => id.toString())
      : conversation.participants
          .map((id) => id.toString())
          .filter((id) => id !== userId),
  );
  const users = await User.find({ _id: { $in: userIds } })
    .select("displayName bio +avatarKey +avatarVersion")
    .lean();
  const userById = new Map(users.map((user) => [user._id.toString(), user]));

  const serialized = await Promise.all(conversations.map(async (conversation) => {
    if (conversation.kind === "group") {
      const group = await findGroupForMember(conversation._id.toString(), userId);
      return group ? serializeGroup(group, userId) : null;
    }
    const otherId = conversation.participants.find((id) => id.toString() !== userId);
    const other = otherId ? userById.get(otherId.toString()) : undefined;
    if (!other) return null;
    return {
      id: conversation._id.toString(),
      kind: "direct" as const,
      otherUser: {
        id: other._id.toString(),
        displayName: other.displayName,
        bio: other.bio ?? "",
        avatarUrl: avatarUrlFor(other),
      },
      latestMessage: conversation.lastMessageText
        ? {
            text: conversation.lastMessageText,
            createdAt: conversation.lastMessageAt?.toISOString() ?? null,
          }
        : null,
    };
  }));

  response.status(200).json({
    conversations: serialized.filter((conversation) => conversation !== null),
  });
});

conversationsRouter.post("/groups", createLimiter, async (request, response) => {
  const input = createGroupSchema.parse(request.body);
  const conversation = await createGroup({
    creatorId: request.session.userId!,
    name: input.name,
    memberIds: input.memberIds,
  });
  await publishGroupUpdate(conversation.id);
  response.status(201).json({ conversation });
});

conversationsRouter.get("/groups/:groupId", async (request, response) => {
  const groupId = objectIdSchema.parse(request.params.groupId);
  const group = await findGroupForMember(groupId, request.session.userId!);
  if (!group) {
    response.status(404).json({ error: { code: "GROUP_NOT_FOUND", message: "Group not found" } });
    return;
  }
  response.status(200).json({ conversation: await serializeGroup(group, request.session.userId!) });
});

conversationsRouter.get("/groups/:groupId/photo", async (request, response) => {
  const groupId = objectIdSchema.parse(request.params.groupId);
  const group = await findGroupForMember(groupId, request.session.userId!);
  if (!group?.photoReference) {
    throw new ChatRequestError(404, "GROUP_PHOTO_NOT_FOUND", "Group photo not found.");
  }
  let data: Buffer;
  try {
    data = await readAvatar(group.photoReference);
  } catch (error) {
    if (error instanceof AvatarRequestError) {
      throw new ChatRequestError(404, "GROUP_PHOTO_NOT_FOUND", "Group photo not found.");
    }
    throw error;
  }
  response
    .status(200)
    .type("image/webp")
    .set("Cache-Control", "private, no-store")
    .set("X-Content-Type-Options", "nosniff")
    .send(data);
});

conversationsRouter.put(
  "/groups/:groupId/photo",
  groupPhotoLimiter,
  requireGroupPhotoAdmin,
  groupPhotoUpload.single("photo"),
  async (request, response) => {
    if (!request.file) {
      throw new AvatarRequestError(400, "GROUP_PHOTO_REQUIRED", "Choose a JPEG, PNG, or WebP image.");
    }
    const groupId = objectIdSchema.parse(request.params.groupId);
    const processed = await processAvatar(request.file.buffer);
    const newKey = await writeAvatar(processed);
    let conversation;
    try {
      conversation = await replaceGroupPhoto(groupId, request.session.userId!, newKey);
    } catch (error) {
      await discardUnreferencedGroupPhoto(newKey);
      throw error;
    }
    await publishGroupUpdate(groupId);
    response.status(200).json({ conversation });
  },
);

conversationsRouter.delete(
  "/groups/:groupId/photo",
  groupPhotoLimiter,
  async (request, response) => {
    const groupId = objectIdSchema.parse(request.params.groupId);
    const conversation = await removeGroupPhoto(groupId, request.session.userId!);
    await publishGroupUpdate(groupId);
    response.status(200).json({ conversation });
  },
);

conversationsRouter.patch("/groups/:groupId", async (request, response) => {
  const groupId = objectIdSchema.parse(request.params.groupId);
  const { name } = renameGroupSchema.parse(request.body);
  const conversation = await renameGroup(groupId, request.session.userId!, name);
  await publishGroupUpdate(conversation.id);
  response.status(200).json({ conversation });
});

conversationsRouter.post("/groups/:groupId/members", async (request, response) => {
  const groupId = objectIdSchema.parse(request.params.groupId);
  const { memberIds } = addGroupMembersSchema.parse(request.body);
  const conversation = await addGroupMembers(groupId, request.session.userId!, memberIds);
  await publishGroupUpdate(conversation.id);
  response.status(200).json({ conversation });
});

conversationsRouter.delete("/groups/:groupId/members/:memberId", async (request, response) => {
  const groupId = objectIdSchema.parse(request.params.groupId);
  const memberId = objectIdSchema.parse(request.params.memberId);
  const conversation = await removeGroupMember(groupId, request.session.userId!, memberId);
  await publishGroupUpdate(conversation.id);
  response.status(200).json({ conversation });
});

conversationsRouter.post("/groups/:groupId/leave", async (request, response) => {
  const groupId = objectIdSchema.parse(request.params.groupId);
  const result = await leaveGroup(groupId, request.session.userId!);
  await publishGroupUpdate(groupId);
  response.status(200).json(result);
});

conversationsRouter.post("/", createLimiter, async (request, response) => {
  const userId = request.session.userId!;
  const { otherUserId } = createConversationSchema.parse(request.body);
  if (otherUserId === userId) {
    response.status(400).json({
      error: { code: "INVALID_PARTICIPANT", message: "Choose another registered user" },
    });
    return;
  }

  const other = await User.findById(otherUserId)
    .select("displayName bio +avatarKey +avatarVersion")
    .exec();
  if (!other) {
    response.status(404).json({
      error: { code: "USER_NOT_FOUND", message: "User not found" },
    });
    return;
  }

  const conversation = await createOrFindConversation(userId, otherUserId);
  response.status(200).json({
    conversation: {
      id: conversation._id.toString(),
      otherUser: {
        id: other._id.toString(),
        displayName: other.displayName,
        bio: other.bio ?? "",
        avatarUrl: avatarUrlFor(other),
      },
      latestMessage: conversation.lastMessageText
        ? {
            text: conversation.lastMessageText,
            createdAt: conversation.lastMessageAt?.toISOString() ?? null,
          }
        : null,
    },
  });
});
