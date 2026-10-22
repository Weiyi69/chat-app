import { Schema, model } from "mongoose";

const userSchema = new Schema(
  {
    displayName: { type: String, required: true, trim: true, maxlength: 64 },
    displayNameSearch: { type: String, required: true, select: false },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    avatarUrl: { type: String, default: null },
    avatarKey: { type: String, default: null, select: false },
    avatarVersion: { type: Number, default: 0, select: false },
  },
  { timestamps: true },
);

userSchema.index({ displayNameSearch: 1 });

export const User = model("User", userSchema);
