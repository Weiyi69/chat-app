import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { env, imageStorageRoot } from "../config/env.js";

export interface StoredImageCandidate {
  key: string;
  lastModified: Date;
}

export interface StoredImagePage {
  objects: StoredImageCandidate[];
  nextCursor?: string;
}

export interface ImageStorage {
  readonly driver: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  readLocal(key: string): Promise<Buffer>;
  signedReadUrl(key: string): Promise<string>;
  listOlderThan(cutoff: Date, limit: number, cursor?: string): Promise<StoredImagePage>;
}

const keyPattern = /^converse\/[a-f\d]{24}\/[a-f\d-]{36}\.(?:jpe?g|png|webp)$/i;

function validateKey(key: string): string {
  if (!keyPattern.test(key)) throw new Error("Invalid internal image storage key");
  return key;
}

function localPath(key: string): string {
  const safeKey = validateKey(key);
  const path = resolve(imageStorageRoot, ...safeKey.split("/"));
  const pathFromRoot = relative(imageStorageRoot, path);
  if (!pathFromRoot || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") {
    throw new Error("Image storage key is outside the configured storage directory");
  }
  return path;
}

class LocalImageStorage implements ImageStorage {
  readonly driver = "local" as const;

  async put(key: string, data: Buffer): Promise<void> {
    const path = localPath(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  }

  async delete(key: string): Promise<void> {
    await rm(localPath(key), { force: true });
  }

  async readLocal(key: string): Promise<Buffer> {
    return readFile(localPath(key));
  }

  async signedReadUrl(): Promise<string> {
    throw new Error("Signed URLs are only supported by S3-compatible storage");
  }

  async listOlderThan(cutoff: Date, limit: number, cursor?: string): Promise<StoredImagePage> {
    const candidates: StoredImageCandidate[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingPath(error)) return;
        throw error;
      }

      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          const key = relative(imageStorageRoot, path).split(sep).join("/");
          if (!keyPattern.test(key)) continue;
          const details = await stat(path);
          if (details.mtime < cutoff) {
            candidates.push({ key, lastModified: details.mtime });
          }
        }
      }
    };

    await visit(imageStorageRoot);
    const eligible = candidates
      .filter((candidate) => candidate.lastModified < cutoff && (!cursor || candidate.key > cursor))
      .sort((first, second) => (first.key < second.key ? -1 : first.key > second.key ? 1 : 0));
    const objects = eligible.slice(0, limit);
    return {
      objects,
      nextCursor: eligible.length > objects.length ? objects.at(-1)?.key : undefined,
    };
  }
}

class S3ImageStorage implements ImageStorage {
  readonly driver = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const { S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
    if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      throw new Error("S3 image storage configuration is incomplete");
    }
    this.bucket = S3_BUCKET;
    this.client = new S3Client({
      region: S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: Boolean(env.S3_ENDPOINT),
      credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: validateKey(key),
        Body: data,
        ContentType: contentType,
        CacheControl: "private, no-store",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }));
  }

  async readLocal(): Promise<Buffer> {
    throw new Error("Local reads are only supported by local image storage");
  }

  async signedReadUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }),
      { expiresIn: env.IMAGE_SIGNED_URL_TTL_SECONDS },
    );
  }

  async listOlderThan(cutoff: Date, limit: number, cursor?: string): Promise<StoredImagePage> {
    const candidates: StoredImageCandidate[] = [];
    const page = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: "converse/",
        ContinuationToken: cursor,
        MaxKeys: limit,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key || !object.LastModified || !keyPattern.test(object.Key)) continue;
      if (object.LastModified < cutoff) {
        candidates.push({ key: object.Key, lastModified: object.LastModified });
      }
    }
    return {
      objects: candidates,
      nextCursor: page.IsTruncated ? page.NextContinuationToken : undefined,
    };
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export const imageStorage: ImageStorage =
  env.IMAGE_STORAGE_DRIVER === "s3" ? new S3ImageStorage() : new LocalImageStorage();
