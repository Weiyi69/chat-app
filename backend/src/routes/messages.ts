import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";

import { env } from "../config/env.js";
import { requireAuthentication } from "../middleware/authenticate.js";
import { Message } from "../models/message.js";
import { publishMessage } from "../sockets/realtime.js";
import { findConversationForMember } from "../services/conversations.js";
import { createPersistedImageMessage } from "../services/image-messages.js";
import { processUploadedImage } from "../services/image-processing.js";
import { imageStorage } from "../services/image-storage.js";
import {
  ChatRequestError,
  createPersistedMessage,
  getMessagePage,
  serializeMessage,
} from "../services/messages.js";
import { objectIdSchema } from "../validators/common.js";
import {
  imageMessageUploadSchema,
  messagePageQuerySchema,
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

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.IMAGE_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 2,
    parts: 3,
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
  response.status(200).json(page);
});

messagesRouter.post("/:conversationId/messages", sendLimiter, async (request, response) => {
  const conversationId = objectIdSchema.parse(request.params.conversationId);
  const input = sendMessageSchema.parse(request.body);
  const message = await createPersistedMessage({
    conversationId,
    senderId: request.session.userId!,
    text: input.text,
    idempotencyKey: input.clientId,
  });
  const serialized = serializeMessage(message);

  publishMessage(serialized);
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
    });
    const serialized = serializeMessage(message);
    publishMessage(serialized);
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
    if (imageStorage.driver === "s3") {
      response.status(200).json({
        url: await imageStorage.signedReadUrl(message.image.storageKey),
      });
      return;
    }

    const image = await imageStorage.readLocal(message.image.storageKey);
    response.status(200).type(message.image.contentType).send(image);
  },
);
