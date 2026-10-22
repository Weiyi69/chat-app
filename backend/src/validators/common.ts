import { z } from "zod";

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const pageSizeSchema = z.coerce.number().int().min(1).max(50).default(25);
