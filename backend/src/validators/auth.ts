import { z } from "zod";

export const registerSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12).max(128),
}).strict();

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(128),
}).strict();
