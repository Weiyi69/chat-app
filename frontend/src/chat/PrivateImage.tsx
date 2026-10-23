import { useEffect, useState } from "react";

import { chatApi } from "../lib/api";

export function PrivateImage({
  path,
  alt,
  onOpen,
}: {
  path: string;
  alt: string;
  onOpen: (path: string, trigger: HTMLButtonElement) => void;
}) {
  const image = usePrivateImage(path);
  if (image.error) {
    return (
      <div className="image-load-error" role="status">
        <span>Image could not be loaded.</span>
        <button type="button" className="quiet-button" onClick={image.retry}>
          Try again
        </button>
      </div>
    );
  }
  if (!image.url) {
    return <p className="image-loading" role="status">Loading image…</p>;
  }
  return (
    <button
      type="button"
      className="message-image-button"
      onClick={(event) => onOpen(path, event.currentTarget)}
      aria-label="Open image"
    >
      <img
        src={image.url}
        alt={alt}
        loading="lazy"
        onError={image.fail}
      />
    </button>
  );
}

export function PrivateImageViewer({ path }: { path: string }) {
  const image = usePrivateImage(path);
  if (image.error) {
    return (
      <div className="image-load-error" role="alert">
        <span>Image could not be loaded.</span>
        <button type="button" className="quiet-button" onClick={image.retry}>
          Try again
        </button>
      </div>
    );
  }
  if (!image.url) {
    return <p className="image-loading" role="status">Loading image…</p>;
  }
  return (
    <img
      src={image.url}
      alt="Enlarged shared image"
      onError={image.fail}
    />
  );
}

function usePrivateImage(path: string) {
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<{
    path: string;
    attempt: number;
    url?: string;
    error?: boolean;
  }>({ path: "", attempt: -1 });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let release: (() => void) | undefined;
    void chatApi.loadPrivateImage(path, controller.signal).then(
      (image) => {
        if (!active) {
          image.revoke();
          return;
        }
        release = image.revoke;
        setLoadState({ path, attempt, url: image.url });
      },
      () => {
        if (active) setLoadState({ path, attempt, error: true });
      },
    );
    return () => {
      active = false;
      controller.abort();
      release?.();
    };
  }, [attempt, path]);

  const currentState =
    loadState.path === path && loadState.attempt === attempt ? loadState : undefined;
  return {
    url: currentState?.url,
    error: currentState?.error ?? false,
    retry: () => setAttempt((value) => value + 1),
    fail: () => setLoadState({ path, attempt, error: true }),
  };
}
