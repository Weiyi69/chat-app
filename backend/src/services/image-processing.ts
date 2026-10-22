import { createHash } from "node:crypto";
import sharp from "sharp";

import { env } from "../config/env.js";
import { ChatRequestError } from "./messages.js";

const maxImagePixels = 40_000_000;
const maxImageDimension = 10_000;

export type SupportedImageContentType = "image/jpeg" | "image/png" | "image/webp";

export interface ProcessedImage {
  data: Buffer;
  contentType: SupportedImageContentType;
  extension: "jpg" | "png" | "webp";
  width: number;
  height: number;
  sha256: string;
}

export class ImageValidationError extends ChatRequestError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
  }
}

function detectImageType(data: Buffer): SupportedImageContentType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function processUploadedImage(data: Buffer): Promise<ProcessedImage> {
  if (data.length === 0) {
    throw new ImageValidationError(400, "IMAGE_EMPTY", "Choose a non-empty image.");
  }
  if (data.length > env.IMAGE_MAX_UPLOAD_BYTES) {
    throw new ImageValidationError(413, "IMAGE_TOO_LARGE", "Image exceeds the upload size limit.");
  }

  const detectedType = detectImageType(data);
  if (!detectedType) {
    throw new ImageValidationError(415, "IMAGE_UNSUPPORTED", "Use a JPEG, PNG, or WebP image.");
  }

  let image: ReturnType<typeof sharp>;
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    image = sharp(data, { failOn: "error", limitInputPixels: maxImagePixels });
    metadata = await image.metadata();
  } catch {
    throw new ImageValidationError(400, "IMAGE_INVALID", "This image is damaged or cannot be decoded.");
  }

  const metadataType: SupportedImageContentType | null =
    metadata.format === "jpeg"
      ? "image/jpeg"
      : metadata.format === "png"
        ? "image/png"
        : metadata.format === "webp"
          ? "image/webp"
          : null;
  if (metadataType !== detectedType) {
    throw new ImageValidationError(415, "IMAGE_UNSUPPORTED", "Use a valid JPEG, PNG, or WebP image.");
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new ImageValidationError(415, "IMAGE_UNSUPPORTED", "Animated images are not supported.");
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width < 1 ||
    height < 1 ||
    width > maxImageDimension ||
    height > maxImageDimension ||
    width * height > maxImagePixels
  ) {
    throw new ImageValidationError(413, "IMAGE_DIMENSIONS_TOO_LARGE", "Image dimensions exceed the supported limit.");
  }

  try {
    const sharpFormat =
      detectedType === "image/jpeg" ? "jpeg" : detectedType === "image/png" ? "png" : "webp";
    const normalized = await image.rotate().toFormat(sharpFormat).toBuffer({
      resolveWithObject: true,
    });
    if (normalized.data.length > env.IMAGE_MAX_UPLOAD_BYTES) {
      throw new ImageValidationError(413, "IMAGE_TOO_LARGE", "Processed image exceeds the storage size limit.");
    }
    if (
      normalized.info.width > maxImageDimension ||
      normalized.info.height > maxImageDimension ||
      normalized.info.width * normalized.info.height > maxImagePixels
    ) {
      throw new ImageValidationError(413, "IMAGE_DIMENSIONS_TOO_LARGE", "Image dimensions exceed the supported limit.");
    }

    const contentType: SupportedImageContentType =
      normalized.info.format === "jpeg"
        ? "image/jpeg"
        : normalized.info.format === "png"
          ? "image/png"
          : "image/webp";
    const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
    return {
      data: normalized.data,
      contentType,
      extension,
      width: normalized.info.width,
      height: normalized.info.height,
      sha256: createHash("sha256").update(normalized.data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError(400, "IMAGE_INVALID", "This image is damaged or cannot be decoded.");
  }
}
