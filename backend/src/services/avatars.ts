import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

import { avatarStorageRoot, env } from "../config/env.js";
import { Conversation } from "../models/conversation.js";
import { User } from "../models/user.js";
import { ChatRequestError } from "./chat-errors.js";

const maxAvatarDimension = 10_000;
const maxAvatarPixels = 40_000_000;
const generatedAvatarKey = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

export class AvatarRequestError extends ChatRequestError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
  }
}

function detectedImageType(data: Buffer): "jpeg" | "png" | "webp" | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpeg";
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export async function processAvatar(data: Buffer): Promise<Buffer> {
  if (data.length === 0) {
    throw new AvatarRequestError(400, "AVATAR_EMPTY", "Choose a non-empty image.");
  }
  if (data.length > env.AVATAR_MAX_UPLOAD_BYTES) {
    throw new AvatarRequestError(413, "AVATAR_TOO_LARGE", "Image exceeds the configured upload size limit.");
  }

  const signature = detectedImageType(data);
  if (!signature) {
    throw new AvatarRequestError(415, "AVATAR_UNSUPPORTED", "Choose a JPEG, PNG, or WebP image.");
  }

  let source: ReturnType<typeof sharp>;
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    source = sharp(data, { failOn: "error", limitInputPixels: maxAvatarPixels });
    metadata = await source.metadata();
  } catch {
    throw new AvatarRequestError(400, "AVATAR_INVALID", "This image is damaged or cannot be decoded.");
  }

  if (
    metadata.format !== signature ||
    (metadata.pages ?? 1) > 1
  ) {
    throw new AvatarRequestError(415, "AVATAR_UNSUPPORTED", "Choose a valid, non-animated JPEG, PNG, or WebP image.");
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width < 1 ||
    height < 1 ||
    width > maxAvatarDimension ||
    height > maxAvatarDimension ||
    width * height > maxAvatarPixels
  ) {
    throw new AvatarRequestError(413, "AVATAR_DIMENSIONS_TOO_LARGE", "Image dimensions exceed the supported limit.");
  }

  try {
    const result = await source
      .rotate()
      .resize(512, 512, { fit: "cover", position: "centre" })
      .webp({ quality: 86, effort: 4 })
      .toBuffer();
    if (result.length > env.AVATAR_MAX_UPLOAD_BYTES) {
      throw new AvatarRequestError(413, "AVATAR_TOO_LARGE", "Processed image exceeds the configured upload size limit.");
    }
    return result;
  } catch (error) {
    if (error instanceof AvatarRequestError) throw error;
    throw new AvatarRequestError(400, "AVATAR_INVALID", "This image is damaged or cannot be decoded.");
  }
}

function avatarPath(key: string): string {
  if (!generatedAvatarKey.test(key)) {
    throw new AvatarRequestError(404, "AVATAR_NOT_FOUND", "Profile photo not found.");
  }
  return join(avatarStorageRoot, key);
}

export async function writeAvatar(data: Buffer): Promise<string> {
  await mkdir(avatarStorageRoot, { recursive: true });
  const key = `${randomUUID()}.webp`;
  await writeFile(avatarPath(key), data, { flag: "wx", mode: 0o600 });
  return key;
}

export async function readAvatar(key: string): Promise<Buffer> {
  try {
    return await readFile(avatarPath(key));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AvatarRequestError(404, "AVATAR_NOT_FOUND", "Profile photo not found.");
    }
    throw error;
  }
}

export async function deleteAvatar(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await unlink(avatarPath(key));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function deleteAvatarIfUnreferenced(key: string | null | undefined): Promise<void> {
  if (!key) return;
  if (await User.exists({ avatarKey: key })) return;
  if (await Conversation.exists({ photoReference: key })) return;
  await deleteAvatar(key);
}

export function avatarUrlFor(user: {
  _id: { toString(): string };
  avatarKey?: string | null;
  avatarVersion?: number;
}): string | null {
  if (!user.avatarKey) return null;
  const version = Number.isSafeInteger(user.avatarVersion) ? user.avatarVersion : 0;
  return `/api/v1/users/${encodeURIComponent(user._id.toString())}/avatar?v=${version}`;
}

export async function cleanupOrphanedAvatars(): Promise<void> {
  const entries = await readdir(avatarStorageRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const keys = entries
    .filter((entry) => entry.isFile() && generatedAvatarKey.test(entry.name))
    .map((entry) => entry.name);
  if (keys.length === 0) return;

  const referenced = new Set(
    [
      ...(await User.distinct("avatarKey", { avatarKey: { $in: keys } })),
      ...(await Conversation.distinct("photoReference", { photoReference: { $in: keys } })),
    ].filter(
      (key): key is string => typeof key === "string",
    ),
  );
  await Promise.all(keys.filter((key) => !referenced.has(key)).map(deleteAvatar));
}
