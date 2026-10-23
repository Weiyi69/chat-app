import { Schema, model } from "mongoose";

const imageSchema = new Schema(
  {
    storageKey: {
      type: String,
      required: true,
      match: /^converse\/[a-f\d]{24}\/[a-f\d-]{36}\.(?:jpe?g|png|webp)$/i,
      immutable: true,
    },
    contentType: { type: String, enum: ["image/jpeg", "image/png", "image/webp"], required: true, immutable: true },
    size: { type: Number, required: true, min: 1, immutable: true },
    width: { type: Number, required: true, min: 1, immutable: true },
    height: { type: Number, required: true, min: 1, immutable: true },
    sha256: { type: String, required: true, match: /^[a-f\d]{64}$/, immutable: true },
  },
  { _id: false },
);

const fileSchema = new Schema(
  {
    storageKey: {
      type: String,
      required: true,
      match: /^converse-attachments\/[a-f\d]{24}\/[a-f\d-]{36}\.(?:pdf|txt|docx|xlsx|csv)$/i,
      immutable: true,
    },
    filename: { type: String, required: true, trim: true, maxlength: 180, immutable: true },
    contentType: {
      type: String,
      enum: [
        "application/pdf",
        "text/plain",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
      ],
      required: true,
      immutable: true,
    },
    size: { type: Number, required: true, min: 1, max: 10 * 1024 * 1024, immutable: true },
    sha256: { type: String, required: true, match: /^[a-f\d]{64}$/, immutable: true },
  },
  { _id: false },
);

const forwardedFromSchema = new Schema(
  {
    originalConversationId: { type: Schema.Types.ObjectId, required: true },
    originalMessageId: { type: Schema.Types.ObjectId, required: true },
    senderName: { type: String, required: true, maxlength: 80 },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      immutable: true,
    },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    type: { type: String, enum: ["text", "image", "file"], default: "text", required: true, immutable: true },
    text: {
      type: String,
      required: function requireTextForTextMessages(this: { type?: string }) {
        return this.type === "text";
      },
      default: "",
      maxlength: 4000,
    },
    image: { type: imageSchema, default: undefined, immutable: true },
    file: { type: fileSchema, default: undefined, immutable: true },
    idempotencyKey: { type: String, required: true, immutable: true },
    replyToMessageId: { type: Schema.Types.ObjectId, ref: "Message", immutable: true },
    forwardedFrom: { type: forwardedFromSchema, immutable: true },
    pinnedAt: { type: Date, default: undefined },
    pinnedBy: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
    editedAt: { type: Date, default: undefined },
    deletedAt: { type: Date, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.pre("validate", function validateMessageContent() {
  if (this.type === "image" && !this.image) {
    this.invalidate("image", "Image messages require validated image metadata");
  }
  if (this.type === "file" && !this.file) {
    this.invalidate("file", "File messages require validated file metadata");
  }
  if (this.type !== "image" && this.image) {
    this.invalidate("image", "Only image messages can include image metadata");
  }
  if (this.type !== "file" && this.file) {
    this.invalidate("file", "Only file messages can include file metadata");
  }
  if ((this.type === "image" && this.file) || (this.type === "file" && this.image)) {
    this.invalidate("type", "Messages cannot include both image and file metadata");
  }
  if (this.type === "text" && !this.text.trim()) {
    this.invalidate("text", "Text messages require message text");
  }
});

messageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
messageSchema.index(
  { conversationId: 1, senderId: 1, idempotencyKey: 1 },
  { unique: true },
);
messageSchema.index({ "image.storageKey": 1 }, { unique: true, sparse: true });
messageSchema.index({ "file.storageKey": 1 }, { unique: true, sparse: true });

export const Message = model("Message", messageSchema);
