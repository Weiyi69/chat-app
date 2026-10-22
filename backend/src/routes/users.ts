import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

import { requireAuthentication } from "../middleware/authenticate.js";
import { User } from "../models/user.js";
import { AvatarRequestError, avatarUrlFor, readAvatar } from "../services/avatars.js";
import { objectIdSchema } from "../validators/common.js";

export const usersRouter = Router();

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const avatarReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const searchSchema = z.object({
  search: z.string().trim().min(2).max(64),
  cursor: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const avatarVersionSchema = z.object({
  v: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

usersRouter.get("/", requireAuthentication, searchLimiter, async (request, response) => {
  const query = searchSchema.parse(request.query);
  const matcher = new RegExp(`^${escapeRegex(query.search.toLowerCase())}`);
  const filter = {
    _id: {
      $ne: request.session.userId,
      ...(query.cursor ? { $gt: query.cursor } : {}),
    },
    $or: [{ displayNameSearch: matcher }, { email: matcher }],
  };
  const users = await User.find(filter)
    .select("displayName +avatarKey +avatarVersion")
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .lean();
  const hasMore = users.length > query.limit;
  const page = users.slice(0, query.limit);

  response.status(200).json({
    users: page.map((user) => ({
      id: user._id.toString(),
      displayName: user.displayName,
      avatarUrl: avatarUrlFor(user),
    })),
    nextCursor: hasMore ? page.at(-1)?._id.toString() ?? null : null,
  });
});

usersRouter.get("/:userId/avatar", requireAuthentication, avatarReadLimiter, async (request, response) => {
  const userId = objectIdSchema.parse(request.params.userId);
  const { v: requestedVersion } = avatarVersionSchema.parse(request.query);
  const user = await User.findById(userId).select("+avatarKey +avatarVersion").exec();
  if (!user?.avatarKey || user.avatarVersion !== requestedVersion) {
    throw new AvatarRequestError(404, "AVATAR_NOT_FOUND", "Profile photo not found.");
  }

  const data = await readAvatar(user.avatarKey);
  response
    .status(200)
    .type("image/webp")
    .set("Cache-Control", "private, max-age=31536000, immutable")
    .set("X-Content-Type-Options", "nosniff")
    .send(data);
});
