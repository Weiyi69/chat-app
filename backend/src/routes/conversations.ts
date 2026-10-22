import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import { requireAuthentication } from "../middleware/authenticate.js";
import { Conversation } from "../models/conversation.js";
import { User } from "../models/user.js";
import { createOrFindConversation } from "../services/conversations.js";
import { avatarUrlFor } from "../services/avatars.js";
import { createConversationSchema } from "../validators/conversations.js";

export const conversationsRouter = Router();

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

conversationsRouter.use(requireAuthentication);

conversationsRouter.get("/", async (request, response) => {
  const userId = request.session.userId!;
  const conversations = await Conversation.find({ participants: userId })
    .sort({ lastActivityAt: -1, _id: -1 })
    .limit(50)
    .lean();
  const otherIds = conversations
    .map((conversation) => conversation.participants.find((id) => id.toString() !== userId))
    .filter((id): id is NonNullable<typeof id> => Boolean(id));
  const users = await User.find({ _id: { $in: otherIds } })
    .select("displayName +avatarKey +avatarVersion")
    .lean();
  const userById = new Map(users.map((user) => [user._id.toString(), user]));

  response.status(200).json({
    conversations: conversations.flatMap((conversation) => {
      const otherId = conversation.participants.find((id) => id.toString() !== userId);
      const other = otherId ? userById.get(otherId.toString()) : undefined;
      if (!other) return [];
      return [
        {
          id: conversation._id.toString(),
          otherUser: {
            id: other._id.toString(),
            displayName: other.displayName,
            avatarUrl: avatarUrlFor(other),
          },
          latestMessage: conversation.lastMessageText
            ? {
                text: conversation.lastMessageText,
                createdAt: conversation.lastMessageAt?.toISOString() ?? null,
              }
            : null,
        },
      ];
    }),
  });
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
    .select("displayName +avatarKey +avatarVersion")
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
