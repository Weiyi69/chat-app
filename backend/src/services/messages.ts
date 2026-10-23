import { Types } from "mongoose";

import { Conversation } from "../models/conversation.js";
import { Message } from "../models/message.js";
import { User } from "../models/user.js";
import { avatarUrlFor } from "./avatars.js";
import { ChatRequestError } from "./chat-errors.js";
import { encodeMessageCursor, encodePinnedMessageCursor } from "../validators/messages.js";
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
  file?: {
    filename: string;
    contentType: string;
    size: number;
  } | null;
  replyToMessageId?: { toString(): string } | null;
  forwardedFrom?: {
    senderName: string;
    createdAt: Date;
  } | null;
  pinnedAt?: Date | null;
  createdAt: Date;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  __v?: number;
}, sender?: { displayName: string; avatarUrl: string | null }, reply?: {
  id: string;
  senderName: string;
  text: string;
  type: string;
} | null) {
  const isDeleted = Boolean(message.deletedAt);
  const serialized = {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    senderId: message.senderId.toString(),
    type: message.type ?? "text",
    text: isDeleted ? "This message was deleted." : message.text ?? "",
    createdAt: message.createdAt.toISOString(),
    revision: message.__v ?? 0,
    ...(message.editedAt ? { editedAt: message.editedAt.toISOString() } : {}),
    ...(message.deletedAt ? { deletedAt: message.deletedAt.toISOString() } : {}),
    ...(message.replyToMessageId
      ? { reply: reply ?? { id: message.replyToMessageId.toString(), senderName: "Original message", text: "Original message unavailable", type: "text" } }
      : {}),
    ...(message.forwardedFrom
      ? { forwardedFrom: { senderName: message.forwardedFrom.senderName, createdAt: message.forwardedFrom.createdAt.toISOString() } }
      : {}),
    ...(message.pinnedAt ? { pinnedAt: message.pinnedAt.toISOString() } : {}),
    ...(sender ? { sender } : {}),
  };
  if (isDeleted) return serialized;
  if (message.image) {
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
  if (message.file) {
    return {
      ...serialized,
      file: {
        filename: message.file.filename,
        contentType: message.file.contentType,
        size: message.file.size,
        url: `/api/v1/conversations/${serialized.conversationId}/messages/${serialized.id}/file`,
      },
    };
  }
  return serialized;
}

export async function serializeMessageForDelivery(message: Parameters<typeof serializeMessage>[0]) {
  const [user, replyMessage] = await Promise.all([
    User.findById(message.senderId).select("displayName +avatarKey +avatarVersion").lean(),
    message.replyToMessageId
      ? Message.findOne({
          _id: message.replyToMessageId,
          conversationId: message.conversationId,
        }).select("_id senderId type text file.filename deletedAt").lean()
      : Promise.resolve(null),
  ]);
  const replySender = replyMessage
    ? await User.findById(replyMessage.senderId).select("displayName").lean()
    : null;
  const reply = replyMessage
    ? {
        id: replyMessage._id.toString(),
        senderName: replySender?.displayName ?? "Former member",
        text: replyMessage.deletedAt
          ? DELETED_MESSAGE_TEXT
          : replyMessage.type === "image"
            ? (replyMessage.text || "Photo")
            : replyMessage.type === "file"
              ? (replyMessage.file?.filename || "File")
              : replyMessage.text || "",
        type: replyMessage.type ?? "text",
      }
    : null;
  return serializeMessage(message, user
    ? { displayName: user.displayName, avatarUrl: avatarUrlFor(user) }
    : undefined, reply);
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
  file?: {
    storageKey: string;
    filename: string;
    contentType: string;
    size: number;
    sha256: string;
  };
  replyToMessageId?: string;
  forwardedFrom?: {
    originalConversationId: string;
    originalMessageId: string;
    senderName: string;
    createdAt: Date;
  };
}) {
  const conversation = await findConversationForMember(input.conversationId, input.senderId);
  if (!conversation || conversation.archivedAt) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }
  if (input.replyToMessageId) {
    const replyMessage = await Message.findOne({
      _id: new Types.ObjectId(input.replyToMessageId),
      conversationId: conversation._id,
    }).select("_id").lean();
    if (!replyMessage) {
      throw new ChatRequestError(404, "REPLY_NOT_FOUND", "Reply target not found");
    }
  }

  let message;
  try {
    message = await Message.create({
      conversationId: new Types.ObjectId(input.conversationId),
      senderId: new Types.ObjectId(input.senderId),
      type: input.image ? "image" : input.file ? "file" : "text",
      text: input.text,
      image: input.image,
      file: input.file,
      idempotencyKey: input.idempotencyKey,
      ...(input.replyToMessageId ? { replyToMessageId: new Types.ObjectId(input.replyToMessageId) } : {}),
      ...(input.forwardedFrom
        ? {
            forwardedFrom: {
              originalConversationId: new Types.ObjectId(input.forwardedFrom.originalConversationId),
              originalMessageId: new Types.ObjectId(input.forwardedFrom.originalMessageId),
              senderName: input.forwardedFrom.senderName,
              createdAt: input.forwardedFrom.createdAt,
            },
          }
        : {}),
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
    const expectedType = input.image ? "image" : input.file ? "file" : "text";
    const sameType = (message.type ?? "text") === expectedType;
    const sameAttachment = input.image
      ? message.image?.sha256 === input.image.sha256
      : input.file
        ? message.file?.sha256 === input.file.sha256 &&
          message.file?.filename === input.file.filename
        : !message.image && !message.file;
    const sameReply = message.replyToMessageId?.toString() === input.replyToMessageId;
    const sameForward = input.forwardedFrom
      ? message.forwardedFrom?.originalConversationId.toString() === input.forwardedFrom.originalConversationId &&
        message.forwardedFrom?.originalMessageId.toString() === input.forwardedFrom.originalMessageId
      : !message.forwardedFrom;
    if (message.text !== input.text || !sameType || !sameAttachment || !sameReply || !sameForward) {
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
        lastMessageText: (message.text || (message.type === "file" ? "[File]" : "[Image]")).slice(0, 200),
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

  const orderedPage = page.reverse();
  const replyIds = orderedPage.flatMap((message) => message.replyToMessageId ? [message.replyToMessageId] : []);
  const replies = await Message.find({
    _id: { $in: replyIds },
    conversationId: new Types.ObjectId(input.conversationId),
  }).select("_id senderId type text deletedAt").lean();
  const replyById = new Map(replies.map((reply) => [reply._id.toString(), reply]));
  const replySenders = await User.find({ _id: { $in: [...new Set(replies.map((reply) => reply.senderId.toString()))] } })
    .select("displayName")
    .lean();
  const replySenderById = new Map(replySenders.map((sender) => [sender._id.toString(), sender.displayName]));

  return {
    messages: orderedPage.map((message) => {
      const sender = senderById.get(message.senderId.toString());
      const replyMessage = message.replyToMessageId
        ? replyById.get(message.replyToMessageId.toString())
        : undefined;
      const reply = replyMessage
        ? {
            id: replyMessage._id.toString(),
            senderName: replySenderById.get(replyMessage.senderId.toString()) ?? "Former member",
            text: replyMessage.deletedAt
              ? DELETED_MESSAGE_TEXT
              : replyMessage.type === "image"
                ? (replyMessage.text || "Photo")
                : replyMessage.type === "file"
                  ? (replyMessage.file?.filename || "File")
                  : replyMessage.text || "",
            type: replyMessage.type ?? "text",
          }
        : null;
      return serializeMessage(message, sender
        ? { displayName: sender.displayName, avatarUrl: avatarUrlFor(sender) }
        : undefined, reply);
    }),
    nextCursor:
      hasMore && oldest
        ? encodeMessageCursor({ createdAt: oldest.createdAt, id: oldest._id.toString() })
        : null,
  };
}

export async function getSharedMediaPage(input: {
  conversationId: string;
  before?: { createdAt: string; id: string };
  limit: number;
}) {
  const conversationObjectId = new Types.ObjectId(input.conversationId);
  const filter: Record<string, unknown> = {
    conversationId: conversationObjectId,
    type: "image",
    deletedAt: { $exists: false },
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
  const senderIds = [...new Set(page.map((message) => message.senderId.toString()))];
  const senders = await User.find({ _id: { $in: senderIds.map((id) => new Types.ObjectId(id)) } })
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

export async function getSharedFilesPage(input: {
  conversationId: string;
  before?: { createdAt: string; id: string };
  limit: number;
}) {
  const conversationId = new Types.ObjectId(input.conversationId);
  const filter: Record<string, unknown> = {
    conversationId,
    type: "file",
    deletedAt: { $exists: false },
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

export async function getPinnedMessagePage(input: {
  conversationId: string;
  before?: { pinnedAt: string; id: string };
  limit: number;
}) {
  const conversationId = new Types.ObjectId(input.conversationId);
  const filter: Record<string, unknown> = {
    conversationId,
    pinnedAt: { $exists: true },
  };
  if (input.before) {
    const pinnedAt = new Date(input.before.pinnedAt);
    filter.$or = [
      { pinnedAt: { $lt: pinnedAt } },
      { pinnedAt, _id: { $lt: new Types.ObjectId(input.before.id) } },
    ];
  }

  const documents = await Message.find(filter)
    .sort({ pinnedAt: -1, _id: -1 })
    .limit(input.limit + 1)
    .lean();
  const hasMore = documents.length > input.limit;
  const page = documents.slice(0, input.limit);
  const last = page.at(-1);
  const senders = await User.find({ _id: { $in: [...new Set(page.map((message) => message.senderId.toString()))] } })
    .select("displayName +avatarKey +avatarVersion")
    .lean();
  const senderById = new Map(senders.map((sender) => [sender._id.toString(), sender]));

  return {
    messages: page.map((message) => {
      const sender = senderById.get(message.senderId.toString());
      return serializeMessage(message, sender
        ? { displayName: sender.displayName, avatarUrl: avatarUrlFor(sender) }
        : undefined);
    }),
    nextCursor:
      hasMore && last?.pinnedAt
        ? encodePinnedMessageCursor({ pinnedAt: last.pinnedAt, id: last._id.toString() })
        : null,
  };
}

export const DELETED_MESSAGE_TEXT = "This message was deleted.";

async function requireOwnMutableMessage(input: {
  conversationId: string;
  messageId: string;
  userId: string;
}) {
  const conversation = await findConversationForMember(input.conversationId, input.userId);
  if (!conversation || conversation.archivedAt) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }
  const message = await Message.findOne({
    _id: new Types.ObjectId(input.messageId),
    conversationId: conversation._id,
    senderId: new Types.ObjectId(input.userId),
  });
  if (!message) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }
  return { conversation, message };
}

async function updateLatestMessagePreview(
  conversationId: Types.ObjectId,
  messageId: Types.ObjectId,
  text: string,
  previousText?: string,
) {
  const latestFilter = previousText === undefined
    ? [{ lastMessageId: messageId }]
    : [
        { lastMessageId: messageId },
        { lastMessageId: null, lastMessageText: previousText },
      ];
  await Conversation.updateOne(
    { _id: conversationId, $or: latestFilter },
    { $set: { lastMessageText: text.slice(0, 200) } },
  );
}

export async function editOwnMessage(input: {
  conversationId: string;
  messageId: string;
  userId: string;
  text: string;
  revision: number;
}) {
  const { conversation, message } = await requireOwnMutableMessage(input);
  if (message.type !== "text") {
    throw new ChatRequestError(400, "MESSAGE_NOT_EDITABLE", "Only text messages can be edited");
  }
  if (message.deletedAt) {
    throw new ChatRequestError(409, "MESSAGE_DELETED", "Deleted messages cannot be edited");
  }
  if ((message.__v ?? 0) !== input.revision) {
    throw new ChatRequestError(409, "MESSAGE_CHANGED", "Message changed before the edit was saved. Reload and retry.");
  }

  const editedAt = new Date();
  const versionFilter = message.__v === undefined
    ? { __v: { $exists: false } }
    : { __v: message.__v };
  const updated = await Message.findOneAndUpdate(
    {
      _id: message._id,
      conversationId: conversation._id,
      senderId: new Types.ObjectId(input.userId),
      type: "text",
      deletedAt: { $exists: false },
      ...versionFilter,
    },
    { $set: { text: input.text, editedAt }, $inc: { __v: 1 } },
    { new: true, runValidators: true },
  );
  if (!updated) {
    throw new ChatRequestError(409, "MESSAGE_CHANGED", "Message changed before the edit was saved. Reload and retry.");
  }
  await updateLatestMessagePreview(
    conversation._id,
    updated._id,
    updated.text,
    message.text.slice(0, 200),
  );
  return updated;
}

export async function deleteOwnMessage(input: {
  conversationId: string;
  messageId: string;
  userId: string;
  revision: number;
}) {
  const { conversation, message } = await requireOwnMutableMessage(input);
  if (message.deletedAt) return { message, changed: false };
  if ((message.__v ?? 0) !== input.revision) {
    throw new ChatRequestError(409, "MESSAGE_CHANGED", "Message changed before deletion. Reload and retry.");
  }

  const deletedAt = new Date();
  const versionFilter = message.__v === undefined
    ? { __v: { $exists: false } }
    : { __v: message.__v };
  const deleted = await Message.findOneAndUpdate(
    {
      _id: message._id,
      conversationId: conversation._id,
      senderId: new Types.ObjectId(input.userId),
      deletedAt: { $exists: false },
      ...versionFilter,
    },
    { $set: { text: DELETED_MESSAGE_TEXT, deletedAt }, $inc: { __v: 1 } },
    { new: true, runValidators: true },
  );
  if (!deleted) {
    const current = await Message.findOne({
      _id: message._id,
      conversationId: conversation._id,
      senderId: new Types.ObjectId(input.userId),
    });
    if (current?.deletedAt) return { message: current, changed: false };
    throw new ChatRequestError(409, "MESSAGE_CHANGED", "Message changed before deletion. Reload and retry.");
  }
  await updateLatestMessagePreview(
    conversation._id,
    deleted._id,
    DELETED_MESSAGE_TEXT,
    (message.text || "[Image]").slice(0, 200),
  );
  return { message: deleted, changed: true };
}

export async function setMessagePinned(input: {
  conversationId: string;
  messageId: string;
  userId: string;
  pinned: boolean;
}) {
  const conversation = await findConversationForMember(input.conversationId, input.userId);
  if (!conversation || conversation.archivedAt) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }
  const current = await Message.findOne({
    _id: new Types.ObjectId(input.messageId),
    conversationId: conversation._id,
  });
  if (!current) throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  if (current.deletedAt) {
    throw new ChatRequestError(409, "MESSAGE_DELETED", "Deleted messages cannot be pinned");
  }
  if (Boolean(current.pinnedAt) === input.pinned) return { message: current, changed: false };

  const versionFilter = current.__v === undefined
    ? { __v: { $exists: false } }
    : { __v: current.__v };
  const stateFilter = current.pinnedAt
    ? { pinnedAt: current.pinnedAt }
    : { pinnedAt: { $exists: false } };
  const updated = await Message.findOneAndUpdate(
    {
      _id: current._id,
      conversationId: conversation._id,
      deletedAt: { $exists: false },
      ...versionFilter,
      ...stateFilter,
    },
    input.pinned
      ? {
          $set: { pinnedAt: new Date(), pinnedBy: new Types.ObjectId(input.userId) },
          $inc: { __v: 1 },
        }
      : {
          $unset: { pinnedAt: 1, pinnedBy: 1 },
          $inc: { __v: 1 },
        },
    { new: true, runValidators: true },
  );
  if (updated) return { message: updated, changed: true };

  const latest = await Message.findOne({
    _id: current._id,
    conversationId: conversation._id,
  });
  if (!latest) throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  if (latest.deletedAt) {
    throw new ChatRequestError(409, "MESSAGE_DELETED", "Deleted messages cannot be pinned");
  }
  if (Boolean(latest.pinnedAt) === input.pinned) return { message: latest, changed: false };
  throw new ChatRequestError(409, "MESSAGE_CHANGED", "Pin status changed. Refresh and retry.");
}

function isAfterOrEqual(
  first: { createdAt: Date; _id: Types.ObjectId },
  second: { createdAt: Date; _id: Types.ObjectId },
) {
  const firstTime = first.createdAt.getTime();
  const secondTime = second.createdAt.getTime();
  return firstTime > secondTime ||
    (firstTime === secondTime && first._id.toString() >= second._id.toString());
}

export async function advanceReadPosition(input: {
  conversationId: string;
  userId: string;
  messageId: string;
}) {
  const message = await Message.findOne({
    _id: new Types.ObjectId(input.messageId),
    conversationId: new Types.ObjectId(input.conversationId),
  }).select("_id createdAt").lean();
  if (!message) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const conversation = await findConversationForMember(input.conversationId, input.userId);
    if (!conversation || conversation.archivedAt) {
      throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
    }
    const current = conversation.readPositions?.find(
      (position) => position.userId.toString() === input.userId,
    );
    if (current?.messageId.toString() === input.messageId) {
      return { changed: false, messageId: input.messageId };
    }

    if (current) {
      const currentMessage = await Message.findOne({
        _id: current.messageId,
        conversationId: conversation._id,
      }).select("_id createdAt").lean();
      if (currentMessage && !isAfterOrEqual(message, currentMessage)) {
        return { changed: false, messageId: current.messageId.toString() };
      }
      current.messageId = message._id;
    } else {
      conversation.set("readPositions", [
        ...(conversation.readPositions ?? []),
        {
          userId: new Types.ObjectId(input.userId),
          messageId: message._id,
        },
      ]);
    }

    try {
      await conversation.save();
      return { changed: true, messageId: message._id.toString() };
    } catch (error) {
      if (error instanceof Error && error.name === "VersionError" && attempt < 3) continue;
      throw error;
    }
  }
  throw new ChatRequestError(409, "READ_POSITION_CONFLICT", "Read status changed. Please retry.");
}

export async function getMessageReaders(input: {
  conversationId: string;
  messageId: string;
  userId: string;
}) {
  const conversation = await findConversationForMember(input.conversationId, input.userId);
  if (!conversation || conversation.archivedAt) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }
  const message = await Message.findOne({
    _id: new Types.ObjectId(input.messageId),
    conversationId: conversation._id,
  }).select("_id senderId createdAt").lean();
  if (!message) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }

  const positions = (conversation.readPositions ?? []).filter((position) =>
    conversation.participants.some((participant) => participant.equals(position.userId)) &&
    !position.userId.equals(message.senderId),
  );
  const readMessages = await Message.find({
    _id: { $in: positions.map((position) => position.messageId) },
    conversationId: conversation._id,
  }).select("_id createdAt").lean();
  const readMessageById = new Map(readMessages.map((readMessage) => [
    readMessage._id.toString(),
    readMessage,
  ]));
  const joinedAtByUser = new Map(
    (conversation.members ?? []).map((member) => [member.userId.toString(), member.joinedAt]),
  );
  const readerIds = positions.flatMap((position) => {
    const readMessage = readMessageById.get(position.messageId.toString());
    if (!readMessage || !isAfterOrEqual(readMessage, message)) return [];
    if (conversation.kind === "group") {
      const joinedAt = joinedAtByUser.get(position.userId.toString());
      if (!joinedAt || joinedAt.getTime() >= message.createdAt.getTime()) return [];
    }
    return [position.userId];
  });
  const users = await User.find({ _id: { $in: readerIds } }).select("displayName").lean();
  return users.map((user) => ({ userId: user._id.toString(), displayName: user.displayName }));
}
