import { useEffect, useState } from "react";

import { chatApi } from "../lib/api";
import type { Message } from "../types";

export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (first, second) =>
      new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime() ||
      first.id.localeCompare(second.id),
  );
}

export function Avatar({
  name,
  avatarUrl,
  className = "",
  fallback = "initial",
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
  fallback?: "initial" | "group";
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    setImageFailed(false);
    setImageUrl(null);
    if (!avatarUrl) return;

    const controller = new AbortController();
    let revoke: () => void = () => undefined;
    void chatApi.loadPrivateImage(avatarUrl, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) {
          loaded.revoke();
          return;
        }
        revoke = loaded.revoke;
        setImageUrl(loaded.url);
      },
      () => {
        if (!controller.signal.aborted) setImageFailed(true);
      },
    );
    return () => {
      controller.abort();
      revoke();
    };
  }, [avatarUrl]);

  return (
    <div className={`avatar ${className} ${fallback === "group" ? "group-avatar" : ""}`} aria-hidden="true">
      {avatarUrl && !imageFailed ? (
        imageUrl ? <img src={imageUrl} alt="" onError={() => setImageFailed(true)} /> : name.trim().charAt(0).toUpperCase()
      ) : fallback === "group" ? (
        <svg viewBox="0 0 24 24" focusable="false">
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19v-1.2a5.5 5.5 0 0 1 11 0V19z" />
          <path d="M16 5.5a3 3 0 0 1 0 5.8M17 14a4.5 4.5 0 0 1 3.5 4.4v.6h-4" />
        </svg>
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </div>
  );
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
