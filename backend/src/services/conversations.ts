import { Types } from "mongoose";

import { Conversation } from "../models/conversation.js";
import { Message } from "../models/message.js";

export function makePairKey(firstUserId: string, secondUserId: string): string {
  return [firstUserId.toLowerCase(), secondUserId.toLowerCase()].sort().join(":");
}

export async function createOrFindConversation(
  firstUserId: string,
  secondUserId: string,
) {
  const pairKey = makePairKey(firstUserId, secondUserId);
  const participants = [firstUserId, secondUserId]
    .sort()
    .map((id) => new Types.ObjectId(id));

  try {
    return await Conversation.findOneAndUpdate(
      { pairKey },
      { $setOnInsert: { pairKey, participants } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      const existing = await Conversation.findOne({ pairKey });
      if (existing) return existing;
    }
    throw error;
  }
}

export async function findConversationForMember(conversationId: string, userId: string) {
  return Conversation.findOne({
    _id: conversationId,
    participants: new Types.ObjectId(userId),
  });
}

export async function listReadPositions(conversationId: string, userId: string) {
  const conversation = await Conversation.findOne({
    _id: conversationId,
    participants: new Types.ObjectId(userId),
    archivedAt: null,
  }).select("kind participants members readPositions").lean();
  if (!conversation) return null;

  const currentMembers = new Set(conversation.participants.map((id) => id.toString()));
  const eligibleMembers = conversation.kind === "group"
    ? new Map((conversation.members ?? []).map((member) => [
        member.userId.toString(),
        member.joinedAt,
      ]))
    : new Map(conversation.participants.map((id) => [id.toString(), new Date(0)]));
  const positions = (conversation.readPositions ?? []).filter((position) =>
    currentMembers.has(position.userId.toString()),
  );
  const messages = await Message.find({ _id: { $in: positions.map((position) => position.messageId) } })
    .select("_id conversationId createdAt")
    .lean();
  const messageById = new Map(messages.map((message) => [message._id.toString(), message]));
  return positions.flatMap((position) => {
    const message = messageById.get(position.messageId.toString());
    const joinedAt = eligibleMembers.get(position.userId.toString());
    if (!message || message.conversationId.toString() !== conversationId || !joinedAt) return [];
    return [{
      userId: position.userId.toString(),
      messageId: message._id.toString(),
      createdAt: message.createdAt.toISOString(),
      joinedAt: joinedAt.toISOString(),
    }];
  });
}
