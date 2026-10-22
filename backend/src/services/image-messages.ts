import { randomUUID } from "node:crypto";

import { Message } from "../models/message.js";
import { ChatRequestError, createPersistedMessage } from "./messages.js";
import type { ProcessedImage } from "./image-processing.js";
import { imageStorage } from "./image-storage.js";

export async function createPersistedImageMessage(input: {
  conversationId: string;
  senderId: string;
  caption: string;
  idempotencyKey: string;
  image: ProcessedImage;
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
      existing.image?.sha256 !== input.image.sha256
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
