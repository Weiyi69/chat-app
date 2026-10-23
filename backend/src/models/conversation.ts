import { Schema, model } from "mongoose";

const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["admin", "member"], required: true },
    joinedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    kind: { type: String, enum: ["direct", "group"], default: "direct" },
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
      required: true,
      validate: {
        validator: function validateParticipants(
          this: { kind?: string },
          participants: Schema.Types.ObjectId[],
        ) {
          return new Set(participants.map(String)).size === participants.length &&
            (this.kind === "group" ? participants.length >= 0 : participants.length === 2);
        },
        message: "Conversation participants must be distinct and match the conversation type",
      },
    },
    pairKey: { type: String, required: true, unique: true, immutable: true },
    name: {
      type: String,
      trim: true,
      maxlength: 80,
      required: function groupNameRequired(this: { kind?: string }) {
        return this.kind === "group";
      },
    },
    photoReference: { type: String, default: null, maxlength: 256 },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function groupCreatorRequired(this: { kind?: string }) {
        return this.kind === "group";
      },
    },
    members: {
      type: [memberSchema],
      default: undefined,
      required: function groupMembersRequired(this: { kind?: string }) {
        return this.kind === "group";
      },
      validate: {
        validator: function validateGroupMembers(
          this: { kind?: string; archivedAt?: Date | null; participants: Schema.Types.ObjectId[] },
          members: { userId: Schema.Types.ObjectId }[] | null | undefined,
        ) {
          if (this.kind !== "group") return true;
          const memberIds = (members ?? []).map((member) => member.userId.toString());
          const uniqueIds = new Set(memberIds);
          const isArchived = Boolean(this.archivedAt);
          return uniqueIds.size === memberIds.length &&
            memberIds.length === this.participants.length &&
            (isArchived ? memberIds.length === 0 : memberIds.length > 0) &&
            memberIds.every((id) => this.participants.some((participant) => participant.toString() === id));
        },
        message: "Group members must match active participants",
      },
    },
    archivedAt: { type: Date, default: null },
    lastMessageId: { type: Schema.Types.ObjectId, ref: "Message", default: null },
    lastMessageText: { type: String, default: null, maxlength: 200 },
    lastMessageAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true, optimisticConcurrency: true },
);

conversationSchema.index({ participants: 1, lastActivityAt: -1, _id: -1 });

export const Conversation = model("Conversation", conversationSchema);
