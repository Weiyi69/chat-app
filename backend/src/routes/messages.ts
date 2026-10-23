import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";

import { env } from "../config/env.js";
import { requireAuthentication } from "../middleware/authenticate.js";
import { Message } from "../models/message.js";
import { publishMessage, publishMessageUpdate } from "../sockets/realtime.js";
import { findConversationForMember, listReadPositions } from "../services/conversations.js";
import { createPersistedImageMessage, forwardPersistedMessage } from "../services/image-messages.js";
import { processUploadedImage } from "../services/image-processing.js";
import { imageStorage } from "../services/image-storage.js";
import {
  ChatRequestError,
  createPersistedMessage,
  deleteOwnMessage,
  editOwnMessage,
  getMessageReaders,
  getMessagePage,
  getSharedMediaPage,
  setMessagePinned,
  serializeMessageForDelivery,
} from "../services/messages.js";
import { objectIdSchema } from "../validators/common.js";
import {
  editMessageSchema,
  deleteMessageSchema,
  forwardMessageSchema,
  imageMessageUploadSchema,
  messagePageQuerySchema,
  pinMessageSchema,
  sharedMediaPageQuerySchema,
  sendMessageSchema,
} from "../validators/messages.js";

export const messagesRouter = Router();

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const imageSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const forwardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (request) => request.session.userId!,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: { code: "RATE_LIMITED", message: "Too many forwards. Please try again in a minute." },
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.IMAGE_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 3,
    parts: 4,
  },
});

messagesRouter.use(requireAuthentication);

messagesRouter.get("/:conversationId/messages", async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const userId = request.session.userId!;
  const conversation = await findConversationForMember(conversationId, userId);
  if (!conversation) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }

  const query = messagePageQuerySchema.parse(request.query);
  const page = await getMessagePage({
    conversationId,
    before: query.before,
    limit: query.limit,
  });
  response.set("Cache-Control", "private, no-store").status(200).json(page);
});

messagesRouter.get("/:conversationId/media", async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const conversation = await findConversationForMember(conversationId, request.session.userId!);
  if (!conversation || conversation.archivedAt) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }

  const query = sharedMediaPageQuerySchema.parse(request.query);
  const page = await getSharedMediaPage({
    conversationId,
    before: query.before,
    limit: query.limit,
  });
  response.set("Cache-Control", "private, no-store").status(200).json(page);
});

messagesRouter.get("/:conversationId/receipts", async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const positions = await listReadPositions(conversationId, request.session.userId!);
  if (!positions) {
    throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  }
  response.set("Cache-Control", "private, no-store").status(200).json({ positions });
});

messagesRouter.get(
  "/:conversationId/messages/:messageId/readers",
  async (request, response) => {
    const conversationId = objectIdSchema.parse(request.params.conversationId);
    const messageId = objectIdSchema.parse(request.params.messageId);
    const readers = await getMessageReaders({
      conversationId,
      messageId,
      userId: request.session.userId!,
    });
    response.set("Cache-Control", "private, no-store").status(200).json({ readers });
  },
);

messagesRouter.patch("/:conversationId/messages/:messageId", async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const messageId = objectIdSchema.parse(request.params.messageId);
  const { text, revision } = editMessageSchema.parse(request.body);
  const message = await editOwnMessage({
    conversationId,
    messageId,
    userId: request.session.userId!,
    text,
    revision,
  });
  const serialized = await serializeMessageForDelivery(message);
  await publishMessageUpdate(serialized);
  response.set("Cache-Control", "private, no-store").status(200).json({ message: serialized });
});

messagesRouter.delete("/:conversationId/messages/:messageId", async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const messageId = objectIdSchema.parse(request.params.messageId);
  const { revision } = deleteMessageSchema.parse(request.body);
  const result = await deleteOwnMessage({
    conversationId,
    messageId,
    userId: request.session.userId!,
    revision,
  });
  const serialized = await serializeMessageForDelivery(result.message);
  if (result.changed) await publishMessageUpdate(serialized);
  response.set("Cache-Control", "private, no-store").status(200).json({ message: serialized });
});

messagesRouter.put("/:conversationId/messages/:messageId/pin", async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const messageId = objectIdSchema.parse(request.params.messageId);
  const { pinned } = pinMessageSchema.parse(request.body);
  const message = await setMessagePinned({
    conversationId,
    messageId,
    userId: request.session.userId!,
    pinned,
  });
  const serialized = await serializeMessageForDelivery(message.message);
  if (message.changed) await publishMessageUpdate(serialized);
  response.set("Cache-Control", "private, no-store").status(200).json({ message: serialized });
});

messagesRouter.post(
  "/:conversationId/messages/:messageId/forward",
  forwardLimiter,
  async (request, response) => {
    const conversationId = objectIdSchema.parse(request.params.conversationId);
    const messageId = objectIdSchema.parse(request.params.messageId);
    const input = forwardMessageSchema.parse(request.body);
    const message = await forwardPersistedMessage({
      sourceConversationId: conversationId,
      messageId,
      destinationConversationId: input.destinationConversationId,
      userId: request.session.userId!,
      idempotencyKey: input.clientId,
    });
    const serialized = await serializeMessageForDelivery(message);
    await publishMessage(serialized);
    response.set("Cache-Control", "private, no-store").status(201).json({ message: serialized });
  },
);

messagesRouter.post("/:conversationId/messages", sendLimiter, async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const input = sendMessageSchema.parse(request.body);
  const message = await createPersistedMessage({
    conversationId,
    senderId: request.session.userId!,
    text: input.text,
    idempotencyKey: input.clientId,
    replyToMessageId: input.replyToMessageId,
  });
  const serialized = await serializeMessageForDelivery(message);

  await publishMessage(serialized);
  response.status(201).json({ message: serialized });
});

messagesRouter.post(
  "/:conversationId/messages/image",
  imageSendLimiter,
  async (request, response, next) => {
    const conversationId = objectIdSchema.parse(request.params.conversationId);
    const conversation = await findConversationForMember(conversationId, request.session.userId!);
    if (!conversation) {
      throw new ChatRequestError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
    }
    next();
  },
  imageUpload.single("image"),
  async (request, response) => {
    if (!request.file) {
      throw new ChatRequestError(400, "IMAGE_REQUIRED", "Choose an image to send.");
    }
    const parsed = imageMessageUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ChatRequestError(400, "INVALID_MESSAGE", "Caption or retry identifier is invalid.");
    }

    const conversationId = objectIdSchema.parse(request.params.conversationId);
    const processed = await processUploadedImage(request.file.buffer);
    const message = await createPersistedImageMessage({
      conversationId,
      senderId: request.session.userId!,
      caption: parsed.data.caption,
      idempotencyKey: parsed.data.clientId,
      image: processed,
      replyToMessageId: parsed.data.replyToMessageId,
    });
    const serialized = await serializeMessageForDelivery(message);
    await publishMessage(serialized);
    response.status(201).json({ message: serialized });
  },
);

messagesRouter.get(
  "/:conversationId/messages/:messageId/image",
  async (request, response) => {
    const conversationId = objectIdSchema.parse(request.params.conversationId);
    const messageId = objectIdSchema.parse(request.params.messageId);
    const conversation = await findConversationForMember(conversationId, request.session.userId!);
    if (!conversation) {
      throw new ChatRequestError(404, "IMAGE_NOT_FOUND", "Image not found");
    }

    const message = await Message.findOne({
      _id: messageId,
      conversationId,
      type: "image",
      deletedAt: { $exists: false },
    }).lean();
    if (!message?.image) {
      throw new ChatRequestError(404, "IMAGE_NOT_FOUND", "Image not found");
    }

    response.set({
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    const image = await imageStorage.read(message.image.storageKey);
    response.status(200).type(message.image.contentType).send(image);
  },
);
