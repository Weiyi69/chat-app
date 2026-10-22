import { Types } from "mongoose";

import { Conversation } from "../models/conversation.js";

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
