import { randomUUID } from "node:crypto";

import { Message } from "../models/message.js";
import { User } from "../models/user.js";
import { findConversationForMember } from "./conversations.js";
import { ChatRequestError, createPersistedMessage } from "./messages.js";
import { processUploadedImage, type ProcessedImage } from "./image-processing.js";
import { imageStorage } from "./image-storage.js";
import { attachmentStorage } from "./attachment-storage.js";
import { createPersistedFileMessage, processUploadedAttachment } from "./file-attachments.js";

export async function createPersistedImageMessage(input: {
  conversationId: string;
  senderId: string;
  caption: string;
  idempotencyKey: string;
  image: ProcessedImage;
  replyToMessageId?: string;
  forwardedFrom?: {
    originalConversationId: string;
    originalMessageId: string;
    senderName: string;
    createdAt: Date;
  };
}) {
  const existing = await Message.findOne({
    conversationId: input.conversationId,
    senderId: input.senderId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    if (
      existing.type !== "image" ||
      existing.text !== input.caption ||
      existing.image?.sha256 !== input.image.sha256 ||
      existing.replyToMessageId?.toString() !== input.replyToMessageId ||
      (input.forwardedFrom
        ? existing.forwardedFrom?.originalConversationId.toString() !== input.forwardedFrom.originalConversationId ||
          existing.forwardedFrom?.originalMessageId.toString() !== input.forwardedFrom.originalMessageId
        : Boolean(existing.forwardedFrom))
    ) {
      throw new ChatRequestError(409, "IDEMPOTENCY_CONFLICT", "Message retry does not match the original");
    }
    return existing;
  }

  const storageKey = `converse/${input.conversationId}/${randomUUID()}.${input.image.extension}`;
  await imageStorage.put(storageKey, input.image.data, input.image.contentType);

  try {
    const message = await createPersistedMessage({
      conversationId: input.conversationId,
      senderId: input.senderId,
      text: input.caption,
      idempotencyKey: input.idempotencyKey,
      image: {
        storageKey,
        contentType: input.image.contentType,
        size: input.image.data.length,
        width: input.image.width,
        height: input.image.height,
        sha256: input.image.sha256,
      },
      replyToMessageId: input.replyToMessageId,
      forwardedFrom: input.forwardedFrom,
    });

    if (message.image?.storageKey !== storageKey) {
      await imageStorage.delete(storageKey);
    }
    return message;
  } catch (error) {
    const isReferenced = await Message.exists({ "image.storageKey": storageKey });
    if (!isReferenced) {
      try {
        await imageStorage.delete(storageKey);
      } catch (cleanupError) {
        console.error(
          "Failed to remove an unreferenced uploaded image",
          cleanupError instanceof Error ? cleanupError.name : "UnknownError",
        );
      }
    }
    throw error;
  }
}

export async function forwardPersistedMessage(input: {
  sourceConversationId: string;
  messageId: string;
  destinationConversationId: string;
  userId: string;
  idempotencyKey: string;
}) {
  if (input.sourceConversationId === input.destinationConversationId) {
    throw new ChatRequestError(400, "INVALID_DESTINATION", "Choose a different conversation.");
  }
  const [sourceConversation, destinationConversation] = await Promise.all([
    findConversationForMember(input.sourceConversationId, input.userId),
    findConversationForMember(input.destinationConversationId, input.userId),
  ]);
  if (!sourceConversation || sourceConversation.archivedAt) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }
  if (!destinationConversation || destinationConversation.archivedAt) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Destination conversation not found");
  }

  const existingForward = await Message.findOne({
    conversationId: destinationConversation._id,
    senderId: input.userId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existingForward?.forwardedFrom?.originalConversationId.toString() === input.sourceConversationId &&
      existingForward.forwardedFrom.originalMessageId.toString() === input.messageId) {
    return existingForward;
  }

  const source = await Message.findOne({
    _id: input.messageId,
    conversationId: sourceConversation._id,
    deletedAt: { $exists: false },
  });
  if (!source) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }
  const originalSender = await User.findById(source.senderId).select("displayName").lean();
  const forwardedFrom = {
    originalConversationId: input.sourceConversationId,
    originalMessageId: source._id.toString(),
    senderName: source.forwardedFrom?.senderName ?? originalSender?.displayName ?? "Former member",
    createdAt: source.forwardedFrom?.createdAt ?? source.createdAt,
  };

  if (source.type === "text") {
    const stillAuthorized = await Promise.all([
      findConversationForMember(input.sourceConversationId, input.userId),
      Message.findOne({
        _id: source._id,
        conversationId: sourceConversation._id,
        deletedAt: { $exists: false },
      }).select("_id").lean(),
    ]);
    if (!stillAuthorized[0] || stillAuthorized[0].archivedAt || !stillAuthorized[1]) {
      throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
    }
    return createPersistedMessage({
      conversationId: input.destinationConversationId,
      senderId: input.userId,
      text: source.text,
      idempotencyKey: input.idempotencyKey,
      forwardedFrom,
    });
  }

  if (source.type === "file" && source.file) {
    const sourceBytes = await attachmentStorage.read(source.file.storageKey);
    const stillAuthorizedSource = await Promise.all([
      findConversationForMember(input.sourceConversationId, input.userId),
      Message.findOne({
        _id: source._id,
        conversationId: sourceConversation._id,
        deletedAt: { $exists: false },
      }).select("_id").lean(),
    ]);
    if (!stillAuthorizedSource[0] || stillAuthorizedSource[0].archivedAt || !stillAuthorizedSource[1]) {
      throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
    }
    const attachment = await processUploadedAttachment({
      data: sourceBytes,
      originalName: source.file.filename,
      declaredMimeType: source.file.contentType,
    });
    return createPersistedFileMessage({
      conversationId: input.destinationConversationId,
      senderId: input.userId,
      text: source.text,
      idempotencyKey: input.idempotencyKey,
      attachment,
      forwardedFrom,
    });
  }

  if (source.type !== "image" || !source.image) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }

  const sourceBytes = await imageStorage.read(source.image.storageKey);
  const stillAuthorizedSource = await Promise.all([
    findConversationForMember(input.sourceConversationId, input.userId),
    Message.findOne({
      _id: source._id,
      conversationId: sourceConversation._id,
      deletedAt: { $exists: false },
    }).select("_id").lean(),
  ]);
  if (!stillAuthorizedSource[0] || stillAuthorizedSource[0].archivedAt || !stillAuthorizedSource[1]) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }

  const copiedImage = await processUploadedImage(sourceBytes);
  const stillAuthorizedAfterProcessing = await Promise.all([
    findConversationForMember(input.sourceConversationId, input.userId),
    Message.findOne({
      _id: source._id,
      conversationId: sourceConversation._id,
      deletedAt: { $exists: false },
    }).select("_id").lean(),
  ]);
  if (
    !stillAuthorizedAfterProcessing[0] ||
    stillAuthorizedAfterProcessing[0].archivedAt ||
    !stillAuthorizedAfterProcessing[1]
  ) {
    throw new ChatRequestError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }
  return createPersistedImageMessage({
    conversationId: input.destinationConversationId,
    senderId: input.userId,
    caption: source.text,
    idempotencyKey: input.idempotencyKey,
    image: copiedImage,
    forwardedFrom,
  });
}

export async function cleanupOrphanedImages(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let cursor: string | undefined;
  do {
    const page = await imageStorage.listOlderThan(cutoff, 1000, cursor);
    const keys = page.objects.map((object) => object.key);
    const referencedKeys = new Set<string>(
      await Message.distinct("image.storageKey", { "image.storageKey": { $in: keys } }),
    );
    for (const object of page.objects) {
      if (!referencedKeys.has(object.key)) await imageStorage.delete(object.key);
    }
    cursor = page.nextCursor;
  } while (cursor);
}
