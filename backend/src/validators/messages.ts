import { z } from "zod";

import { objectIdSchema, pageSizeSchema } from "./common.js";

const cursorPayloadSchema = z.object({
  createdAt: z.iso.datetime(),
  id: objectIdSchema,
}).strict();

const cursorSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .transform((encoded, context) => {
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      context.addIssue({ code: "custom", message: "Invalid cursor" });
      return z.NEVER;
    }

    const parsed = cursorPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "Invalid cursor" });
      return z.NEVER;
    }
    return parsed.data;
  });

export const messagePageQuerySchema = z.object({
  before: cursorSchema.optional(),
  limit: pageSizeSchema,
});

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  clientId: z.uuid(),
}).strict();

export const imageMessageUploadSchema = z.object({
  caption: z.string().trim().max(4000).default(""),
  clientId: z.uuid(),
}).strict();

export const socketMessageSchema = sendMessageSchema.extend({
  conversationId: objectIdSchema,
}).strict();

export const socketJoinSchema = z.object({
  conversationId: objectIdSchema,
}).strict();

export function encodeMessageCursor(cursor: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}
