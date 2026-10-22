import { z } from "zod";

import { objectIdSchema } from "./common.js";

export const createConversationSchema = z.object({
  otherUserId: objectIdSchema,
}).strict();
