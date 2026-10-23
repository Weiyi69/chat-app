import { z } from "zod";

import { objectIdSchema } from "./common.js";

export const createConversationSchema = z.object({
  otherUserId: objectIdSchema,
}).strict();

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(objectIdSchema).min(2).max(50),
}).strict().refine(
  ({ memberIds }) => new Set(memberIds).size === memberIds.length,
  { message: "Group members must be unique", path: ["memberIds"] },
);

export const renameGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
}).strict();

export const addGroupMembersSchema = z.object({
  memberIds: z.array(objectIdSchema).min(1).max(50),
}).strict().refine(
  ({ memberIds }) => new Set(memberIds).size === memberIds.length,
  { message: "Group members must be unique", path: ["memberIds"] },
);
