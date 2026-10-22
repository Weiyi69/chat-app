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
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
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
    <div className={`avatar ${className}`} aria-hidden="true">
      {avatarUrl && !imageFailed ? (
        imageUrl ? <img src={imageUrl} alt="" onError={() => setImageFailed(true)} /> : name.trim().charAt(0).toUpperCase()
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
