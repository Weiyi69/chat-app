import { Schema, model } from "mongoose";

const conversationSchema = new Schema(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
      required: true,
      validate: {
        validator: (participants: Schema.Types.ObjectId[]) =>
          participants.length === 2 && new Set(participants.map(String)).size === 2,
        message: "A private conversation requires two distinct participants",
      },
    },
    pairKey: { type: String, required: true, unique: true, immutable: true },
    lastMessageId: { type: Schema.Types.ObjectId, ref: "Message", default: null },
    lastMessageText: { type: String, default: null, maxlength: 200 },
    lastMessageAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1, lastActivityAt: -1, _id: -1 });

export const Conversation = model("Conversation", conversationSchema);
