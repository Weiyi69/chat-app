import argon2 from "argon2";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import type { Request } from "express";

import { env } from "../config/env.js";
import { requireAuthentication } from "../middleware/authenticate.js";
import { User } from "../models/user.js";
import {
  AvatarRequestError,
  avatarUrlFor,
  deleteAvatarIfUnreferenced,
  processAvatar,
  writeAvatar,
} from "../services/avatars.js";
import { revokeSessionConnections } from "../sockets/realtime.js";
import { loginSchema, registerSchema } from "../validators/auth.js";

export const authRouter = Router();

const authenticationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
});

const avatarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many photo updates. Please try again later." } },
});
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.AVATAR_MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
});

async function discardUnreferencedAvatar(key: string, context: string): Promise<void> {
  await deleteAvatarIfUnreferenced(key).catch((error: unknown) => {
    console.error(context, error instanceof Error ? error.name : "UnknownError");
  });
}

function serializeUser(user: {
  _id: { toString(): string };
  displayName: string;
  email: string;
  avatarUrl?: string | null;
  avatarKey?: string | null;
  avatarVersion?: number;
}) {
  return {
    id: user._id.toString(),
    displayName: user.displayName,
    email: user.email,
    avatarUrl: avatarUrlFor(user),
  };
}

function regenerateSession(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

authRouter.post("/register", authenticationLimiter, async (request, response) => {
  const input = registerSchema.parse(request.body);
  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  try {
    const previousSessionId = request.sessionID;
    const user = await User.create({
      displayName: input.displayName,
      displayNameSearch: input.displayName.toLowerCase(),
      email: input.email,
      passwordHash,
    });
    await regenerateSession(request);
    revokeSessionConnections(previousSessionId);
    request.session.userId = user._id.toString();
    await saveSession(request);

    response.status(201).json({ user: serializeUser(user) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      response.status(409).json({
        error: { code: "REGISTRATION_FAILED", message: "Unable to register with those details" },
      });
      return;
    }
    throw error;
  }
});

authRouter.post("/login", authenticationLimiter, async (request, response) => {
  const input = loginSchema.parse(request.body);
  const user = await User.findOne({ email: input.email }).select("+passwordHash +avatarKey +avatarVersion");

  if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
    response.status(401).json({
      error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" },
    });
    return;
  }

  const previousSessionId = request.sessionID;
  await regenerateSession(request);
  revokeSessionConnections(previousSessionId);
  request.session.userId = user._id.toString();
  await saveSession(request);

  response.status(200).json({ user: serializeUser(user) });
});

authRouter.put(
  "/me/avatar",
  requireAuthentication,
  avatarLimiter,
  avatarUpload.single("avatar"),
  async (request, response) => {
    if (!request.file) {
      throw new AvatarRequestError(400, "AVATAR_REQUIRED", "Choose a JPEG, PNG, or WebP image.");
    }
    const processed = await processAvatar(request.file.buffer);
    const newKey = await writeAvatar(processed);
    let current;
    try {
      current = await User.findById(request.session.userId)
        .select("+avatarKey +avatarVersion")
        .exec();
    } catch (error) {
      await discardUnreferencedAvatar(newKey, "Failed avatar upload cleanup failed");
      throw error;
    }
    if (!current) {
      await discardUnreferencedAvatar(newKey, "Failed avatar upload cleanup failed");
      throw new AvatarRequestError(404, "USER_NOT_FOUND", "Account not found.");
    }

    const previousKey = current.avatarKey ?? null;
    const currentReference = previousKey
      ? { avatarKey: previousKey }
      : { $or: [{ avatarKey: null }, { avatarKey: { $exists: false } }] };
    let updated;
    try {
      updated = await User.findOneAndUpdate(
        { _id: current._id, ...currentReference },
        { $set: { avatarKey: newKey }, $inc: { avatarVersion: 1 } },
        { new: true, runValidators: true },
      )
        .select("+avatarKey +avatarVersion")
        .exec();
    } catch (error) {
      await discardUnreferencedAvatar(newKey, "Failed avatar upload cleanup failed");
      throw error;
    }
    if (!updated) {
      await discardUnreferencedAvatar(newKey, "Failed avatar upload cleanup failed");
      throw new AvatarRequestError(409, "AVATAR_CHANGED", "Your photo changed in another request. Please retry.");
    }

    if (previousKey) {
      await discardUnreferencedAvatar(previousKey, "Replaced avatar cleanup failed");
    }
    response.status(200).json({ user: serializeUser(updated) });
  },
);

authRouter.delete("/me/avatar", requireAuthentication, avatarLimiter, async (request, response) => {
  const user = await User.findById(request.session.userId).select("+avatarKey +avatarVersion").exec();
  if (!user) {
    throw new AvatarRequestError(404, "USER_NOT_FOUND", "Account not found.");
  }
  if (!user.avatarKey) {
    response.status(200).json({ user: serializeUser(user) });
    return;
  }

  const previousKey = user.avatarKey;
  const updated = await User.findOneAndUpdate(
    { _id: user._id, avatarKey: previousKey },
    { $set: { avatarKey: null }, $inc: { avatarVersion: 1 } },
    { new: true, runValidators: true },
  )
    .select("+avatarKey +avatarVersion")
    .exec();
  if (!updated) {
    throw new AvatarRequestError(409, "AVATAR_CHANGED", "Your photo changed in another request. Please retry.");
  }

  await discardUnreferencedAvatar(previousKey, "Removed avatar cleanup failed");
  response.status(200).json({ user: serializeUser(updated) });
});

authRouter.post("/logout", async (request, response) => {
  const previousSessionId = request.sessionID;
  if (!request.session.userId) {
    response.status(204).end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    request.session.destroy((error) => (error ? reject(error) : resolve()));
  });
  revokeSessionConnections(previousSessionId);

  response.clearCookie(env.NODE_ENV === "production" ? "__Host-converse.sid" : "converse.sid", {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  response.status(204).end();
});

authRouter.get("/me", async (request, response) => {
  const userId = request.session.userId;
  if (!userId) {
    response.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    return;
  }

  const user = await User.findById(userId)
    .select("displayName email +avatarKey +avatarVersion")
    .exec();
  if (!user) {
    const previousSessionId = request.sessionID;
    await new Promise<void>((resolve, reject) => {
      request.session.destroy((error) => (error ? reject(error) : resolve()));
    });
    revokeSessionConnections(previousSessionId);
    response.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    return;
  }

  response.status(200).json({ user: serializeUser(user) });
});
