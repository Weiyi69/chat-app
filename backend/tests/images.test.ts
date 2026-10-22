import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { processUploadedImage } from "../src/services/image-processing.js";

describe("image processing", () => {
  it.each([
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const)("accepts and normalizes %s using its actual signature", async (format, contentType) => {
    const input = await sharp({
      create: { width: 8, height: 5, channels: 3, background: "#456789" },
    }).toFormat(format).toBuffer();

    const processed = await processUploadedImage(input);

    expect(processed.contentType).toBe(contentType);
    expect(processed.width).toBe(8);
    expect(processed.height).toBe(5);
    expect(processed.sha256).toMatch(/^[a-f\d]{64}$/);
    const outputMetadata = await sharp(processed.data).metadata();
    expect(outputMetadata.format).toBe(format);
    expect(outputMetadata.exif).toBeUndefined();
  });

  it("rejects a supported signature that does not contain a decodable image", async () => {
    const malformedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not a PNG"),
    ]);

    await expect(processUploadedImage(malformedPng)).rejects.toMatchObject({
      status: 400,
      code: "IMAGE_INVALID",
    });
  });

  it("rejects dimensions above the per-side ceiling", async () => {
    const largeImage = await sharp({
      create: { width: 10_001, height: 1, channels: 3, background: "#456789" },
    }).png().toBuffer();

    await expect(processUploadedImage(largeImage)).rejects.toMatchObject({
      status: 413,
      code: "IMAGE_DIMENSIONS_TOO_LARGE",
    });
  });
});
