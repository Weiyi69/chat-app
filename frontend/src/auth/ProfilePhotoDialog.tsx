import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { useAuth } from "./AuthProvider";
import { authApi } from "../lib/api";
import { Avatar } from "../chat/chat-utils";

const defaultMaxUploadBytes = 5 * 1024 * 1024;
const supportedTypes = ["image/jpeg", "image/png", "image/webp"];
const maxDisplayNameLength = 64;
const maxBioLength = 160;

export function ProfilePhotoDialog({ onClose }: { onClose: () => void }) {
  const { user, updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [valuesInitialized, setValuesInitialized] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [maxUploadBytes, setMaxUploadBytes] = useState(defaultMaxUploadBytes);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const valuesTouched = useRef(false);
  const saveInProgress = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const nameError = displayName.trim().length === 0
    ? "Enter a display name."
    : displayName.trim().length > maxDisplayNameLength
      ? `Display name must be ${maxDisplayNameLength} characters or fewer.`
      : "";
  const bioError = bio.length > maxBioLength
    ? `Bio must be ${maxBioLength} characters or fewer.`
    : "";
  const dirty = displayName !== (user?.displayName ?? "") ||
    bio !== (user?.bio ?? "") ||
    file !== null ||
    removePhoto;

  useEffect(() => {
    if (!user || valuesInitialized || valuesTouched.current) return;
    setDisplayName(user.displayName);
    setBio(user.bio);
    setValuesInitialized(true);
  }, [user, valuesInitialized]);

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
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
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
    setRemovePhoto(false);
    setProgress(0);
  }

  async function saveChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveInProgress.current || !dirty || nameError || bioError) return;
    saveInProgress.current = true;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await updateProfile({
        displayName: displayName.trim(),
        bio,
        avatar: file,
        removeAvatar: removePhoto,
      }, setProgress);
      setDisplayName(displayName.trim());
      setFile(null);
      setRemovePhoto(false);
      setProgress(0);
      setSuccess("Profile changes saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Profile could not be saved. Try again.");
    } finally {
      saveInProgress.current = false;
      setBusy(false);
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
        aria-labelledby="profile-heading"
      >
        <header className="profile-photo-header">
          <div>
            <p className="eyebrow">YOUR ACCOUNT</p>
            <h2 id="profile-heading">Edit profile</h2>
          </div>
          <button type="button" className="quiet-button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </header>
        <form onSubmit={(event) => void saveChanges(event)}>
          <section className="profile-editor-section profile-editor-photo-section" aria-labelledby="profile-photo-section">
            <h3 id="profile-photo-section">Profile photo</h3>
            <div className="profile-photo-preview" aria-live="polite">
              {previewUrl ? (
                <img src={previewUrl} alt="Preview of selected profile photo" />
              ) : (
                <Avatar
                  name={displayName || "?"}
                  avatarUrl={removePhoto ? null : user?.avatarUrl}
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
            {(user?.avatarUrl || removePhoto) && (
              <button
                type="button"
                className="quiet-button danger-button profile-photo-remove"
                onClick={() => {
                  setRemovePhoto((current) => !current);
                  setFile(null);
                  setError("");
                  setSuccess("");
                }}
                disabled={busy}
              >
                {removePhoto ? "Undo remove photo" : "Remove photo"}
              </button>
            )}
            {file && (
              <button
                type="button"
                className="quiet-button profile-photo-discard"
                onClick={() => setFile(null)}
                disabled={busy}
              >
                Discard selected photo
              </button>
            )}
          </section>
          <div className="profile-editor-fields">
            <section className="profile-editor-section">
              <label className="profile-editor-label" htmlFor="profile-display-name">Display name</label>
              <input
                id="profile-display-name"
                className="profile-editor-input"
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(event) => {
                  valuesTouched.current = true;
                  setDisplayName(event.target.value);
                  setError("");
                  setSuccess("");
                }}
                maxLength={maxDisplayNameLength}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? "profile-name-error" : undefined}
                disabled={busy}
              />
              {nameError && <p id="profile-name-error" className="field-error">{nameError}</p>}
            </section>
            <section className="profile-editor-section">
              <label className="profile-editor-label" htmlFor="profile-bio">Bio</label>
              <textarea
                id="profile-bio"
                className="profile-editor-textarea"
                value={bio}
                onChange={(event) => {
                  valuesTouched.current = true;
                  setBio(event.target.value);
                  setError("");
                  setSuccess("");
                }}
                placeholder="Tell people a little about yourself..."
                maxLength={maxBioLength}
                rows={3}
                aria-invalid={Boolean(bioError)}
                aria-describedby={bioError ? "profile-bio-error profile-bio-counter" : "profile-bio-counter"}
                disabled={busy}
              />
              <div className="profile-bio-meta">
                {bioError && <p id="profile-bio-error" className="field-error">{bioError}</p>}
                <span id="profile-bio-counter" aria-live="polite">{bio.length}/{maxBioLength}</span>
              </div>
            </section>
          </div>
          {settingsError && <p className="muted-note" role="status">{settingsError}</p>}
          {busy && file && (
            <div className="profile-photo-progress">
              <progress aria-label="Profile photo upload progress" max={100} value={progress} />
              <span role="status">Saving profile: {progress}%</span>
            </div>
          )}
          {error && <p className="form-error profile-photo-message" role="alert">{error}</p>}
          {success && <p className="profile-photo-success" role="status">{success}</p>}
          <div className="profile-photo-actions">
            <button type="button" className="quiet-button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button profile-photo-save"
              disabled={!dirty || Boolean(nameError) || Boolean(bioError) || busy}
            >
              {busy ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}
