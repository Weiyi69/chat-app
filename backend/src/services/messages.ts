import { Types } from "mongoose";

import { Conversation } from "../models/conversation.js";
import { Message } from "../models/message.js";
import { User } from "../models/user.js";
import { avatarUrlFor } from "./avatars.js";
import { ChatRequestError } from "./chat-errors.js";
import { encodeMessageCursor } from "../validators/messages.js";
import { findConversationForMember } from "./conversations.js";

export { ChatRequestError } from "./chat-errors.js";

export function serializeMessage(message: {
  _id: { toString(): string };
  conversationId: { toString(): string };
  senderId: { toString(): string };
  type?: string;
  text?: string;
  image?: {
    contentType: string;
    size: number;
    width: number;
    height: number;
  } | null;
  createdAt: Date;
}, sender?: { displayName: string; avatarUrl: string | null }) {
  const serialized = {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    senderId: message.senderId.toString(),
    type: message.type ?? "text",
    text: message.text ?? "",
    createdAt: message.createdAt.toISOString(),
    ...(sender ? { sender } : {}),
  };
  if (!message.image) return serialized;
  return {
    ...serialized,
    image: {
      contentType: message.image.contentType,
      size: message.image.size,
      width: message.image.width,
      height: message.image.height,
      url: `/api/v1/conversations/${serialized.conversationId}/messages/${serialized.id}/image`,
    },
  };
}

export async function serializeMessageForDelivery(message: Parameters<typeof serializeMessage>[0]) {
  const user = await User.findById(message.senderId)
    .select("displayName +avatarKey +avatarVersion")
    .lean();
  return serializeMessage(message, user
    ? { displayName: user.displayName, avatarUrl: avatarUrlFor(user) }
    : undefined);
}

export async function createPersistedMessage(input: {
  conversationId: string;
  senderId: string;
  text: string;
  idempotencyKey: string;
  image?: {
    storageKey: string;
    contentType: string;
    size: number;
    width: number;
    height: number;
    sha256: string;
  };
}) {
  const conversation = await findConversationForMember(input.conversationId, input.senderId);
  if (!conversation) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }

  let message;
  try {
    message = await Message.create({
      conversationId: new Types.ObjectId(input.conversationId),
      senderId: new Types.ObjectId(input.senderId),
      type: input.image ? "image" : "text",
      text: input.text,
      image: input.image,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) {
      throw error;
    }

    message = await Message.findOne({
      conversationId: input.conversationId,
      senderId: input.senderId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!message) throw error;
    const sameType = (message.type ?? "text") === (input.image ? "image" : "text");
    const sameImage = input.image
      ? message.image?.sha256 === input.image.sha256
      : !message.image;
    if (message.text !== input.text || !sameType || !sameImage) {
      throw new ChatRequestError(409, "IDEMPOTENCY_CONFLICT", "Message retry does not match the original");
    }
  }

  await Conversation.updateOne(
    {
      _id: conversation._id,
      $or: [
        { lastMessageAt: null },
        { lastMessageAt: { $lt: message.createdAt } },
        {
          lastMessageAt: message.createdAt,
          lastMessageId: { $lt: message._id },
        },
      ],
    },
    {
      $set: {
        lastMessageId: message._id,
        lastMessageText: (message.text || "[Image]").slice(0, 200),
        lastMessageAt: message.createdAt,
        lastActivityAt: message.createdAt,
      },
    },
  );

  return message;
}

export async function getMessagePage(input: {
  conversationId: string;
  before?: { createdAt: string; id: string };
  limit: number;
}) {
  const filter: Record<string, unknown> = {
    conversationId: new Types.ObjectId(input.conversationId),
  };
  if (input.before) {
    const createdAt = new Date(input.before.createdAt);
    filter.$or = [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: new Types.ObjectId(input.before.id) } },
    ];
  }

  const documents = await Message.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(input.limit + 1)
    .lean();
  const hasMore = documents.length > input.limit;
  const page = documents.slice(0, input.limit);
  const oldest = page.at(-1);
  const senders = await User.find({ _id: { $in: [...new Set(page.map((message) => message.senderId.toString()))] } })
    .select("displayName +avatarKey +avatarVersion")
    .lean();
  const senderById = new Map(senders.map((sender) => [sender._id.toString(), sender]));

  return {
    messages: page.reverse().map((message) => {
      const sender = senderById.get(message.senderId.toString());
      return serializeMessage(message, sender
        ? { displayName: sender.displayName, avatarUrl: avatarUrlFor(sender) }
        : undefined);
    }),
    nextCursor:
      hasMore && oldest
        ? encodeMessageCursor({ createdAt: oldest.createdAt, id: oldest._id.toString() })
        : null,
  };
}
