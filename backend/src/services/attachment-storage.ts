import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { env, imageStorageRoot } from "../config/env.js";

const attachmentKeyPattern =
  /^converse-attachments\/[a-f\d]{24}\/[a-f\d-]{36}\.(?:pdf|txt|docx|xlsx|csv)$/i;

function validateAttachmentKey(key: string): string {
  if (!attachmentKeyPattern.test(key)) throw new Error("Invalid internal attachment storage key");
  return key;
}

function localPath(key: string): string {
  const path = resolve(imageStorageRoot, ...validateAttachmentKey(key).split("/"));
  const pathFromRoot = relative(imageStorageRoot, path);
  if (!pathFromRoot || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") {
    throw new Error("Attachment storage key is outside the configured storage directory");
  }
  return path;
}

export interface AttachmentStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalAttachmentStorage implements AttachmentStorage {
  async put(key: string, data: Buffer): Promise<void> {
    const path = localPath(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  }

  async read(key: string): Promise<Buffer> {
    return readFile(localPath(key));
  }

  async delete(key: string): Promise<void> {
    await rm(localPath(key), { force: true });
  }
}

class S3AttachmentStorage implements AttachmentStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const { S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
    if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      throw new Error("S3 attachment storage configuration is incomplete");
    }
    this.bucket = S3_BUCKET;
    this.client = new S3Client({
      region: S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: Boolean(env.S3_ENDPOINT),
      credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: validateAttachmentKey(key),
      Body: data,
      ContentType: contentType,
      CacheControl: "private, no-store",
      ContentDisposition: "attachment",
    }));
  }

  async read(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: validateAttachmentKey(key),
    }));
    if (!response.Body) throw new Error("Stored attachment response has no body");
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: validateAttachmentKey(key),
    }));
  }
}

export const attachmentStorage: AttachmentStorage =
  env.IMAGE_STORAGE_DRIVER === "s3" ? new S3AttachmentStorage() : new LocalAttachmentStorage();
