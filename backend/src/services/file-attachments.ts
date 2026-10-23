import { createHash, randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";

import { env } from "../config/env.js";
import { Message } from "../models/message.js";
import { createPersistedMessage, ChatRequestError } from "./messages.js";
import { attachmentStorage } from "./attachment-storage.js";

export const ATTACHMENT_CONTENT_TYPES = {
  pdf: "application/pdf",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
} as const;

export type AttachmentExtension = keyof typeof ATTACHMENT_CONTENT_TYPES;

const allowedMimeTypes: Record<AttachmentExtension, readonly string[]> = {
  pdf: ["application/pdf"],
  txt: ["text/plain"],
  docx: [ATTACHMENT_CONTENT_TYPES.docx],
  xlsx: [ATTACHMENT_CONTENT_TYPES.xlsx],
  csv: ["text/csv", "application/csv", "application/vnd.ms-excel"],
};

function isAttachmentExtension(value: string | undefined): value is AttachmentExtension {
  return value !== undefined && Object.hasOwn(ATTACHMENT_CONTENT_TYPES, value);
}

export interface ProcessedAttachment {
  data: Buffer;
  filename: string;
  contentType: (typeof ATTACHMENT_CONTENT_TYPES)[AttachmentExtension];
  extension: AttachmentExtension;
  size: number;
  sha256: string;
}

export function sanitizeAttachmentFilename(filename: string): string {
  const baseName = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = Array.from(baseName.normalize("NFC"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  if (!normalized || normalized.length > 180) {
    throw new ChatRequestError(400, "ATTACHMENT_FILENAME_INVALID", "Choose a file with a valid filename.");
  }
  return normalized;
}

function isPlainText(data: Buffer): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    for (const character of text) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function processUploadedAttachment(input: {
  data: Buffer;
  originalName: string;
  declaredMimeType: string;
}): Promise<ProcessedAttachment> {
  if (input.data.length === 0) {
    throw new ChatRequestError(400, "ATTACHMENT_INVALID", "The selected file is empty or invalid.");
  }
  if (input.data.length > env.ATTACHMENT_MAX_UPLOAD_BYTES) {
    throw new ChatRequestError(413, "ATTACHMENT_TOO_LARGE", "File exceeds the 10 MB attachment limit.");
  }

  const filename = sanitizeAttachmentFilename(input.originalName);
  const extensionCandidate = filename.split(".").at(-1)?.toLowerCase();
  if (!isAttachmentExtension(extensionCandidate)) {
    throw new ChatRequestError(415, "ATTACHMENT_UNSUPPORTED", "Choose a PDF, TXT, DOCX, XLSX, or CSV file.");
  }
  const extension = extensionCandidate;
  const contentType = ATTACHMENT_CONTENT_TYPES[extension];
  if (!allowedMimeTypes[extension].includes(input.declaredMimeType.toLowerCase())) {
    throw new ChatRequestError(415, "ATTACHMENT_MIME_MISMATCH", "The file type does not match its extension.");
  }

  if (extension === "txt" || extension === "csv") {
    if (!isPlainText(input.data)) {
      throw new ChatRequestError(415, "ATTACHMENT_SIGNATURE_INVALID", "The file contents do not match a text file.");
    }
  } else if (extension === "pdf") {
    const detected = await fileTypeFromBuffer(input.data);
    const header = input.data.subarray(0, Math.min(input.data.length, 16)).toString("ascii");
    const trailer = input.data.subarray(Math.max(0, input.data.length - 2048)).toString("ascii");
    if (
      !detected ||
      detected.ext !== extension ||
      detected.mime !== contentType ||
      !/^%PDF-\d\.\d/.test(header) ||
      !trailer.includes("%%EOF")
    ) {
      throw new ChatRequestError(415, "ATTACHMENT_SIGNATURE_INVALID", "The file contents do not match a PDF.");
    }
  } else {
    const detected = await fileTypeFromBuffer(input.data);
    if (!detected || detected.ext !== extension || detected.mime !== contentType) {
      throw new ChatRequestError(415, "ATTACHMENT_SIGNATURE_INVALID", "The file contents do not match its extension.");
    }
    const requiredArchiveEntry = extension === "docx" ? "word/document.xml" : "xl/workbook.xml";
    if (
      (!input.data.includes(Buffer.from("[Content_Types].xml")) ||
        !input.data.includes(Buffer.from(requiredArchiveEntry)))
    ) {
      throw new ChatRequestError(415, "ATTACHMENT_SIGNATURE_INVALID", "The Office document structure is invalid.");
    }
    if (
      (extension === "docx" && input.data.includes(Buffer.from("word/vbaProject.bin"))) ||
      (extension === "xlsx" && input.data.includes(Buffer.from("xl/vbaProject.bin")))
    ) {
      throw new ChatRequestError(415, "ATTACHMENT_UNSUPPORTED", "Macro-enabled Office documents are not supported.");
    }
  }

  return {
    data: input.data,
    filename,
    contentType,
    extension,
    size: input.data.length,
    sha256: createHash("sha256").update(input.data).digest("hex"),
  };
}

export async function createPersistedFileMessage(input: {
  conversationId: string;
  senderId: string;
  text: string;
  idempotencyKey: string;
  attachment: ProcessedAttachment;
  replyToMessageId?: string;
  forwardedFrom?: {
    originalConversationId: string;
    originalMessageId: string;
    senderName: string;
    createdAt: Date;
  };
}) {
  const existing = await Message.findOne({
    conversationId: input.conversationId,
    senderId: input.senderId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    const sameForward = input.forwardedFrom
      ? existing.forwardedFrom?.originalConversationId.toString() === input.forwardedFrom.originalConversationId &&
        existing.forwardedFrom.originalMessageId.toString() === input.forwardedFrom.originalMessageId
      : !existing.forwardedFrom;
    if (
      existing.type !== "file" ||
      existing.text !== input.text ||
      existing.file?.sha256 !== input.attachment.sha256 ||
      existing.file?.filename !== input.attachment.filename ||
      existing.replyToMessageId?.toString() !== input.replyToMessageId ||
      !sameForward
    ) {
      throw new ChatRequestError(409, "IDEMPOTENCY_CONFLICT", "Message retry does not match the original");
    }
    return existing;
  }

  const storageKey = `converse-attachments/${input.conversationId}/${randomUUID()}.${input.attachment.extension}`;
  await attachmentStorage.put(storageKey, input.attachment.data, input.attachment.contentType);
  try {
    const message = await createPersistedMessage({
      conversationId: input.conversationId,
      senderId: input.senderId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      file: {
        storageKey,
        filename: input.attachment.filename,
        contentType: input.attachment.contentType,
        size: input.attachment.size,
        sha256: input.attachment.sha256,
      },
      replyToMessageId: input.replyToMessageId,
      forwardedFrom: input.forwardedFrom,
    });
    if (message.file?.storageKey !== storageKey) await attachmentStorage.delete(storageKey);
    return message;
  } catch (error) {
    const isReferenced = await Message.exists({ "file.storageKey": storageKey });
    if (!isReferenced) {
      try {
        await attachmentStorage.delete(storageKey);
      } catch (cleanupError) {
        console.error(
          "Failed to remove an unreferenced uploaded attachment",
          cleanupError instanceof Error ? cleanupError.name : "UnknownError",
        );
      }
    }
    throw error;
  }
}
