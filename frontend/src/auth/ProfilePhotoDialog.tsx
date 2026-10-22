import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { useAuth } from "./AuthProvider";
import { authApi } from "../lib/api";
import { Avatar } from "../chat/chat-utils";

const defaultMaxUploadBytes = 5 * 1024 * 1024;
const supportedTypes = ["image/jpeg", "image/png", "image/webp"];

export function ProfilePhotoDialog({ onClose }: { onClose: () => void }) {
  const { user, updateAvatar, removeAvatar } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [maxUploadBytes, setMaxUploadBytes] = useState(defaultMaxUploadBytes);
  const [progress, setProgress] = useState(0);
  const [operation, setOperation] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const busy = operation !== null;

  useEffect(() => {
    let active = true;
    void authApi.avatarLimits().then(
      (limits) => {
        if (active) setMaxUploadBytes(limits.maxUploadBytes);
      },
      () => {
        if (active) setSettingsError("Upload limits are unavailable; the server will validate your photo.");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")
      ?.focus();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key === "Tab") {
        const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled])",
        ) ?? [])];
        if (elements.length === 0) return;
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  function selectPhoto(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!selected) return;
    setError("");
    setSuccess("");
    if (!supportedTypes.includes(selected.type)) {
      setFile(null);
      setError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (selected.size > maxUploadBytes) {
      setFile(null);
      setError(`Choose an image smaller than ${formatSize(maxUploadBytes)}.`);
      return;
    }
    setFile(selected);
    setProgress(0);
  }

  async function savePhoto() {
    if (!file || busy) return;
    setOperation("save");
    setError("");
    setSuccess("");
    try {
      await updateAvatar(file, setProgress);
      setFile(null);
      setProgress(0);
      setSuccess("Profile photo updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Profile photo could not be saved. Try again.");
    } finally {
      setOperation(null);
    }
  }

  async function removePhoto() {
    if (!user?.avatarUrl || busy) return;
    setOperation("remove");
    setError("");
    setSuccess("");
    try {
      await removeAvatar();
      setFile(null);
      setProgress(0);
      setSuccess("Profile photo removed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Profile photo could not be removed. Try again.");
    } finally {
      setOperation(null);
    }
  }

  return (
    <div
      className="profile-photo-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="profile-photo-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-photo-heading"
      >
        <header className="profile-photo-header">
          <div>
            <p className="eyebrow">YOUR ACCOUNT</p>
            <h2 id="profile-photo-heading">Profile photo</h2>
          </div>
          <button type="button" className="quiet-button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </header>
        <div className="profile-photo-preview" aria-live="polite">
          {previewUrl ? (
            <img src={previewUrl} alt="Preview of selected profile photo" />
          ) : (
            <Avatar
              name={user?.displayName ?? "?"}
              avatarUrl={user?.avatarUrl}
              className="profile-photo-avatar"
            />
          )}
        </div>
        <label className="profile-photo-picker">
          <span>{file ? "Choose a different photo" : "Choose a photo"}</span>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="Choose a profile photo"
            onChange={selectPhoto}
            disabled={busy}
          />
        </label>
        <p className="profile-photo-help">
          JPEG, PNG, or WebP. Maximum {formatSize(maxUploadBytes)}. Images are center-cropped to a square.
        </p>
        {settingsError && <p className="muted-note" role="status">{settingsError}</p>}
        {operation === "save" && file && (
          <div className="profile-photo-progress">
            <progress aria-label="Profile photo upload progress" max={100} value={progress} />
            <span role="status">Uploading photo: {progress}%</span>
          </div>
        )}
        {error && <p className="form-error profile-photo-message" role="alert">{error}</p>}
        {success && <p className="profile-photo-success" role="status">{success}</p>}
        <div className="profile-photo-actions">
          {user?.avatarUrl && (
            <button
              type="button"
              className="quiet-button danger-button"
              onClick={() => void removePhoto()}
              disabled={busy}
            >
              {operation === "remove" ? "Removing..." : "Remove photo"}
            </button>
          )}
          <button type="button" className="quiet-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button profile-photo-save"
            onClick={() => void savePhoto()}
            disabled={!file || busy}
          >
            {operation === "save" ? "Saving..." : "Save photo"}
          </button>
        </div>
      </section>
    </div>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}
