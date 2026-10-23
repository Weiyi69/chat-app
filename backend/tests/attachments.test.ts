import { describe, expect, it } from "vitest";

import {
  processUploadedAttachment,
  sanitizeAttachmentFilename,
} from "../src/services/file-attachments.js";

function makeZip(entries: Record<string, string>): Buffer {
  let offset = 0;
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  for (const [filename, contents] of Object.entries(entries)) {
    const name = Buffer.from(filename);
    const data = Buffer.from(contents);
    let checksum = 0xffffffff;
    for (const byte of data) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
      }
    }
    checksum = (checksum ^ 0xffffffff) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localEntries.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralEntries.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, centralDirectory, end]);
}

const contentTypes = (mimeType: string) =>
  `<?xml version="1.0"?><Types><Override PartName="/main.xml" ContentType="${mimeType}"/></Types>`;

describe("file attachment validation", () => {
  it.each([
    ["notes.txt", "text/plain", Buffer.from("These are UTF-8 notes.\n")],
    ["data.csv", "text/csv", Buffer.from("name,value\nExample,42\n")],
    ["report.pdf", "application/pdf", Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n")],
  ])("accepts a valid %s based on its contents and declared type", async (filename, mime, data) => {
    const attachment = await processUploadedAttachment({
      data,
      originalName: filename,
      declaredMimeType: mime,
    });
    expect(attachment.filename).toBe(filename);
    expect(attachment.size).toBe(data.length);
    expect(attachment.sha256).toMatch(/^[a-f\d]{64}$/);
  });

  it.each([
    [
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      makeZip({
        "[Content_Types].xml": contentTypes(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ),
        "word/document.xml": "<document/>",
      }),
    ],
    [
      "report.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      makeZip({
        "[Content_Types].xml": contentTypes(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        ),
        "xl/workbook.xml": "<workbook/>",
      }),
    ],
  ])("accepts a valid OpenXML archive for %s", async (filename, mime, data) => {
    await expect(processUploadedAttachment({
      data,
      originalName: filename,
      declaredMimeType: mime,
    })).resolves.toMatchObject({ filename, contentType: mime });
  });

  it("sanitizes paths and control characters from the display filename", () => {
    expect(sanitizeAttachmentFilename("C:\\private\\folder\\report\u202E.pdf"))
      .toBe("report.pdf");
    expect(() => sanitizeAttachmentFilename("   ")).toThrow();
    expect(() => sanitizeAttachmentFilename(`${"a".repeat(180)}.txt`)).toThrow();
  });

  it.each([
    ["program.exe", "application/octet-stream", Buffer.from("MZ executable")],
    ["fake.pdf", "application/pdf", Buffer.from("not a PDF")],
    ["report.pdf", "text/plain", Buffer.from("%PDF-1.7\n%%EOF")],
    ["notes.txt", "text/plain", Buffer.from([0, 1, 2, 3])],
    ["report.constructor", "application/pdf", Buffer.from("%PDF-1.7\n%%EOF")],
  ])("rejects unsupported or mismatched content for %s", async (filename, mime, data) => {
    await expect(processUploadedAttachment({
      data,
      originalName: filename,
      declaredMimeType: mime,
    })).rejects.toMatchObject({ status: 415 });
  });

  it("rejects empty and oversized files", async () => {
    await expect(processUploadedAttachment({
      data: Buffer.alloc(0),
      originalName: "empty.txt",
      declaredMimeType: "text/plain",
    })).rejects.toMatchObject({ status: 400, code: "ATTACHMENT_INVALID" });

    await expect(processUploadedAttachment({
      data: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
      originalName: "large.txt",
      declaredMimeType: "text/plain",
    })).rejects.toMatchObject({ status: 413, code: "ATTACHMENT_TOO_LARGE" });
  });
});
