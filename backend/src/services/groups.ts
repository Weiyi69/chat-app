import { Types } from "mongoose";

import { Conversation } from "../models/conversation.js";
import { User } from "../models/user.js";
import { ChatRequestError } from "./chat-errors.js";
import { avatarUrlFor, deleteAvatarIfUnreferenced } from "./avatars.js";

type GroupMember = {
  userId: Types.ObjectId;
  role: "admin" | "member";
  joinedAt: Date;
};

type GroupConversation = {
  _id: Types.ObjectId;
  kind?: string;
  name?: string | null;
  photoReference?: string | null;
  creatorId?: Types.ObjectId | null;
  participants: Types.ObjectId[];
  members?: GroupMember[] | null;
  archivedAt?: Date | null;
  lastMessageText?: string | null;
  lastMessageAt?: Date | null;
  updatedAt?: Date;
};

type MutableGroup = GroupConversation & {
  members: GroupMember[];
  readPositions?: { userId: Types.ObjectId; messageId: Types.ObjectId }[];
  save: () => Promise<unknown>;
};

export async function serializeGroup(conversation: GroupConversation, userId: string) {
  const members = conversation.members ?? [];
  const users = await User.find({ _id: { $in: members.map((member) => member.userId) } })
    .select("displayName +avatarKey +avatarVersion")
    .lean();
  const usersById = new Map(users.map((user) => [user._id.toString(), user]));
  const currentMember = members.find((member) => member.userId.toString() === userId);

  return {
    id: conversation._id.toString(),
    kind: "group" as const,
    name: conversation.name ?? "Group",
    photoReference: conversation.photoReference ?? null,
    photoUrl: conversation.photoReference
      ? `/api/v1/conversations/groups/${conversation._id.toString()}/photo?v=${encodeURIComponent(conversation.photoReference)}`
      : null,
    currentRole: currentMember?.role ?? "member",
    members: members.flatMap((member) => {
      const user = usersById.get(member.userId.toString());
      if (!user) return [];
      return [{
        userId: user._id.toString(),
        displayName: user.displayName,
        avatarUrl: avatarUrlFor(user),
        role: member.role,
        joinedAt: member.joinedAt.toISOString(),
      }];
    }),
    latestMessage: conversation.lastMessageText
      ? {
          text: conversation.lastMessageText,
          createdAt: conversation.lastMessageAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function createGroup(input: {
  creatorId: string;
  name: string;
  memberIds: string[];
}) {
  const creatorObjectId = new Types.ObjectId(input.creatorId);
  const memberIds = input.memberIds.map((id) => id.toLowerCase());
  if (memberIds.includes(input.creatorId.toLowerCase())) {
    throw new ChatRequestError(400, "INVALID_MEMBERS", "Choose members other than yourself");
  }
  const users = await User.find({ _id: { $in: memberIds } }).select("_id").lean();
  if (users.length !== memberIds.length) {
    throw new ChatRequestError(400, "INVALID_MEMBERS", "One or more selected users do not exist");
  }

  const groupId = new Types.ObjectId();
  const now = new Date();
  const conversation = await Conversation.create({
    _id: groupId,
    kind: "group",
    name: input.name,
    photoReference: null,
    creatorId: creatorObjectId,
    pairKey: `group:${groupId.toString()}`,
    participants: [creatorObjectId, ...memberIds.map((id) => new Types.ObjectId(id))],
    members: [
      { userId: creatorObjectId, role: "admin", joinedAt: now },
      ...memberIds.map((id) => ({
        userId: new Types.ObjectId(id),
        role: "member",
        joinedAt: now,
      })),
    ],
  });
  return serializeGroup(conversation, input.creatorId);
}

export async function findGroupForMember(groupId: string, userId: string) {
  const group = await Conversation.findOne({
    _id: groupId,
    kind: "group",
    participants: new Types.ObjectId(userId),
    archivedAt: null,
  });
  return group as unknown as MutableGroup | null;
}

async function mutateGroup(
  groupId: string,
  actorId: string,
  mutate: (group: MutableGroup) => Promise<void> | void,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const group = await findGroupForMember(groupId, actorId);
    if (!group) {
      throw new ChatRequestError(404, "GROUP_NOT_FOUND", "Group not found");
    }
    await mutate(group);
    try {
      await group.save();
      return group;
    } catch (error) {
      if (error instanceof Error && error.name === "VersionError" && attempt < 2) continue;
      throw error;
    }
  }
  throw new ChatRequestError(409, "GROUP_UPDATE_CONFLICT", "Group changed. Please retry.");
}

function requireAdmin(group: MutableGroup, actorId: string) {
  if (!group.members.some((member) => member.userId.toString() === actorId && member.role === "admin")) {
    throw new ChatRequestError(403, "GROUP_ADMIN_REQUIRED", "A group admin is required");
  }
}

export async function requireGroupAdmin(groupId: string, actorId: string) {
  const group = await findGroupForMember(groupId, actorId);
  if (!group) {
    throw new ChatRequestError(404, "GROUP_NOT_FOUND", "Group not found");
  }
  requireAdmin(group, actorId);
}

async function cleanupGroupPhoto(key: string | null, context: string) {
  if (!key) return;
  try {
    await deleteAvatarIfUnreferenced(key);
  } catch (error) {
    console.error(context, error instanceof Error ? error.name : "UnknownError");
  }
}

export async function replaceGroupPhoto(groupId: string, actorId: string, photoKey: string) {
  let previousKey: string | null = null;
  const group = await mutateGroup(groupId, actorId, (current) => {
    requireAdmin(current, actorId);
    previousKey = current.photoReference ?? null;
    current.photoReference = photoKey;
  });
  if (previousKey !== photoKey) {
    await cleanupGroupPhoto(previousKey, "Replaced group photo cleanup failed");
  }
  return serializeGroup(group, actorId);
}

export async function removeGroupPhoto(groupId: string, actorId: string) {
  let previousKey: string | null = null;
  const group = await mutateGroup(groupId, actorId, (current) => {
    requireAdmin(current, actorId);
    previousKey = current.photoReference ?? null;
    current.photoReference = null;
  });
  await cleanupGroupPhoto(previousKey, "Removed group photo cleanup failed");
  return serializeGroup(group, actorId);
}

function syncParticipants(group: MutableGroup) {
  group.participants = group.members.map((member) => member.userId);
}

function removeMember(
  group: MutableGroup,
  userId: string,
) {
  const removed = group.members.find((member) => member.userId.toString() === userId);
  if (!removed) throw new ChatRequestError(404, "GROUP_MEMBER_NOT_FOUND", "Group member not found");
  group.members = group.members.filter((member) => member.userId.toString() !== userId);
  group.readPositions = (group.readPositions ?? []).filter(
    (position) => position.userId.toString() !== userId,
  );
  if (
    removed.role === "admin" &&
    !group.members.some((member) => member.role === "admin") &&
    group.members.length > 0
  ) {
    const nextAdmin = [...group.members].sort(
      (first, second) => first.joinedAt.getTime() - second.joinedAt.getTime(),
    )[0];
    if (nextAdmin) nextAdmin.role = "admin";
  }
  syncParticipants(group);
  if (group.members.length === 0) group.archivedAt = new Date();
}

export async function renameGroup(groupId: string, actorId: string, name: string) {
  const group = await mutateGroup(groupId, actorId, (current) => {
    requireAdmin(current, actorId);
    current.name = name;
  });
  return serializeGroup(group, actorId);
}

export async function addGroupMembers(groupId: string, actorId: string, memberIds: string[]) {
  const normalizedMemberIds = memberIds.map((id) => id.toLowerCase());
  const group = await mutateGroup(groupId, actorId, async (current) => {
    requireAdmin(current, actorId);
    if (normalizedMemberIds.some((id) =>
      current.members.some((member) => member.userId.toString() === id))) {
      throw new ChatRequestError(409, "GROUP_MEMBER_EXISTS", "A selected user is already a group member");
    }
    const users = await User.find({ _id: { $in: normalizedMemberIds } }).select("_id").lean();
    if (users.length !== normalizedMemberIds.length) {
      throw new ChatRequestError(400, "INVALID_MEMBERS", "One or more selected users do not exist");
    }
    const joinedAt = new Date();
    current.members.push(...normalizedMemberIds.map((id) => ({
      userId: new Types.ObjectId(id),
      role: "member" as const,
      joinedAt,
    })));
    syncParticipants(current);
  });
  return serializeGroup(group, actorId);
}

export async function removeGroupMember(groupId: string, actorId: string, memberId: string) {
  const normalizedMemberId = memberId.toLowerCase();
  const group = await mutateGroup(groupId, actorId, (current) => {
    requireAdmin(current, actorId);
    if (actorId.toLowerCase() === normalizedMemberId) {
      throw new ChatRequestError(400, "USE_GROUP_LEAVE", "Use the leave action to remove yourself");
    }
    removeMember(current, normalizedMemberId);
  });
  return serializeGroup(group, actorId);
}

export async function leaveGroup(groupId: string, actorId: string) {
  const group = await mutateGroup(groupId, actorId, (current) => removeMember(current, actorId));
  return { id: group._id.toString(), archived: Boolean(group.archivedAt) };
}
