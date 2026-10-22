import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { chatApi } from "../lib/api";
import type { Conversation, MessagePage } from "../types";
import { Avatar, formatDate, formatTime, mergeMessages } from "./chat-utils";

export function ChatView({
  conversation,
  currentUserId,
  messagesQuery,
  socketConnected,
  socketError,
  onBack,
  onSend,
  onSendImage,
}: {
  conversation: Conversation;
  currentUserId: string;
  messagesQuery: UseQueryResult<MessagePage, Error>;
  socketConnected: boolean;
  socketError: string;
  onBack: () => void;
  onSend: (text: string, clientId: string) => Promise<void>;
  onSendImage: (
    file: File,
    caption: string,
    clientId: string,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [imageRetryAvailable, setImageRetryAvailable] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const imageIdempotencyKey = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const viewerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const queryClient = useQueryClient();
  const imageLimitsQuery = useQuery({
    queryKey: ["image-limits"],
    queryFn: chatApi.imageLimits,
    staleTime: Infinity,
  });
  const page = messagesQuery.data;
  const messages = page?.messages ?? [];

  useEffect(() => {
    const container = scrollRef.current;
    if (container && pinnedToBottom.current) container.scrollTop = container.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!viewerPath) {
      viewerTriggerRef.current?.focus();
      viewerTriggerRef.current = null;
      return;
    }
    viewerCloseRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setViewerPath(null);
      if (event.key === "Tab") {
        event.preventDefault();
        viewerCloseRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [viewerPath]);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  function clearSelectedImage() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setSelectedImage(null);
    imageIdempotencyKey.current = null;
    setImageRetryAvailable(false);
    setUploadProgress(0);
    setSendError("");
  }

  function handleImageSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setSendError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    const maxUploadBytes = imageLimitsQuery.data?.maxUploadBytes ?? 5 * 1024 * 1024;
    if (file.size > maxUploadBytes) {
      setSendError(`Images must be ${formatUploadSize(maxUploadBytes)} or smaller.`);
      return;
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(file);
    previewUrlRef.current = url;
    setPreviewUrl(url);
    setSelectedImage(file);
    imageIdempotencyKey.current = null;
    setImageRetryAvailable(false);
    setSendError("");
    setUploadProgress(0);
  }

  async function sendDraft() {
    const text = draft.trim();
    if ((!text && !selectedImage) || sending) return;
    setSending(true);
    setSendError("");
    try {
      if (selectedImage) {
        imageIdempotencyKey.current ??= window.crypto.randomUUID();
        const controller = new AbortController();
        uploadController.current = controller;
        setUploadProgress(0);
        await onSendImage(
          selectedImage,
          text,
          imageIdempotencyKey.current,
          setUploadProgress,
          controller.signal,
        );
        clearSelectedImage();
      } else {
        idempotencyKey.current ??= window.crypto.randomUUID();
        await onSend(text, idempotencyKey.current);
        idempotencyKey.current = null;
      }
      setDraft("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setSendError("Upload cancelled. You can retry sending the image.");
        if (selectedImage) setImageRetryAvailable(true);
      } else {
        setSendError(error instanceof Error ? error.message : "Message could not be sent. Try again.");
        if (selectedImage) setImageRetryAvailable(true);
      }
    } finally {
      uploadController.current = null;
      setSending(false);
    }
  }

  async function loadOlder() {
    if (!page?.nextCursor || messagesQuery.isFetching) return;
    try {
      const older = await chatApi.messages(conversation.id, page.nextCursor);
      queryClient.setQueryData<MessagePage>(["messages", conversation.id], (current) => ({
        messages: mergeMessages(older.messages, current?.messages ?? []),
        nextCursor: older.nextCursor,
      }));
      pinnedToBottom.current = false;
    } catch {
      setSendError("Older messages could not be loaded.");
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendDraft();
    }
  }

  return (
    <div className="chat-view">
      <header className="chat-header">
        <button type="button" className="back-button" onClick={onBack} aria-label="Back to conversations">
          ←
        </button>
        <Avatar
          name={conversation.otherUser.displayName}
          avatarUrl={conversation.otherUser.avatarUrl}
          className="large"
        />
        <div className="chat-contact">
          <h2>{conversation.otherUser.displayName}</h2>
          <span>
            <span className={`status-dot ${socketConnected ? "online" : ""}`} />
            {socketConnected ? "Available" : "Reconnecting"}
          </span>
        </div>
        <div className="chat-header-mark" aria-hidden="true">C</div>
      </header>

      {socketError && <p className="connection-banner" role="status">{socketError}</p>}

      <div
        className="message-history"
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          pinnedToBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
        }}
        aria-live="polite"
        aria-label={`Messages with ${conversation.otherUser.displayName}`}
      >
        {page?.nextCursor && (
          <button
            type="button"
            className="load-older"
            onClick={() => void loadOlder()}
            disabled={messagesQuery.isFetching}
          >
            {messagesQuery.isFetching ? "Loading..." : "Load older messages"}
          </button>
        )}
        {messagesQuery.isLoading && <p className="muted-note centered">Loading messages...</p>}
        {messagesQuery.error && (
          <div className="error-panel centered">
            <p>Could not load this conversation.</p>
            <button type="button" className="quiet-button" onClick={() => void messagesQuery.refetch()}>
              Try again
            </button>
          </div>
        )}
        {!messagesQuery.isLoading && !messagesQuery.error && messages.length === 0 && (
          <div className="first-message">
            <Avatar
              name={conversation.otherUser.displayName}
              avatarUrl={conversation.otherUser.avatarUrl}
              className="large"
            />
            <h3>Say hello to {conversation.otherUser.displayName.split(" ")[0]}.</h3>
            <p>This is the beginning of your conversation.</p>
          </div>
        )}
        {messages.map((message, index) => {
          const own = message.senderId === currentUserId;
          const image = message.image;
          const showDate =
            index === 0 ||
            new Date(messages[index - 1].createdAt).toDateString() !==
              new Date(message.createdAt).toDateString();
          return (
            <div key={message.id}>
              {showDate && <div className="date-divider">{formatDate(message.createdAt)}</div>}
              <div className={`message-row ${own ? "own" : ""}`}>
                {!own && (
                  <Avatar name={conversation.otherUser.displayName} avatarUrl={conversation.otherUser.avatarUrl} />
                )}
                <div className={`message-content ${own ? "own" : ""}`}>
                  {message.type === "image" && image ? (
                    <div className={`message-bubble image-message-bubble ${own ? "own" : ""}`}>
                      <MessageImage
                        path={image.url}
                        alt={message.text || "Shared image"}
                        onOpen={(path, trigger) => {
                          viewerTriggerRef.current = trigger;
                          setViewerPath(path);
                        }}
                      />
                      {message.text && <p className="image-caption">{message.text}</p>}
                    </div>
                  ) : (
                    <div className={`message-bubble ${own ? "own" : ""}`}>{message.text}</div>
                  )}
                  <time>{formatTime(message.createdAt)}</time>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void sendDraft();
        }}
      >
        {sendError && <p className="send-error" role="alert">{sendError}</p>}
        {selectedImage && previewUrl && (
          <div className="image-preview">
            <img src={previewUrl} alt="Selected image preview" />
            <div className="image-preview-details">
              <span>{selectedImage.name}</span>
              {sending && (
                <>
                  <progress aria-label="Image upload progress" max={100} value={uploadProgress} />
                  <span role="status">Uploading image: {uploadProgress}%</span>
                </>
              )}
            </div>
            {sending ? (
              <button
                type="button"
                className="quiet-button"
                onClick={() => uploadController.current?.abort()}
              >
                Cancel upload
              </button>
            ) : (
              <button type="button" className="quiet-button" onClick={clearSelectedImage}>
                Remove image
              </button>
            )}
          </div>
        )}
        <div className="composer-box">
          <label className="attach-button" aria-label="Attach an image" title="Attach an image">
            <span aria-hidden="true">＋</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Choose an image"
              onChange={handleImageSelected}
              disabled={sending}
            />
          </label>
          <textarea
            aria-label="Write a message"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (selectedImage) {
                imageIdempotencyKey.current = null;
                setImageRetryAvailable(false);
              } else {
                idempotencyKey.current = null;
              }
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder="Write a message..."
            rows={1}
            maxLength={4000}
            disabled={sending}
          />
          <button
            className="send-button"
            type="submit"
            disabled={(!draft.trim() && !selectedImage) || sending}
            aria-label={
              sending
                ? "Sending message"
                : selectedImage && imageRetryAvailable
                  ? "Retry image"
                  : selectedImage
                    ? "Send image"
                    : "Send message"
            }
          >
            {sending ? "..." : selectedImage && sendError ? "Retry" : "↑"}
          </button>
        </div>
        <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
      </form>
      {viewerPath && (
        <div
          className="image-viewer-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setViewerPath(null);
          }}
        >
          <section className="image-viewer" role="dialog" aria-modal="true" aria-label="Image viewer">
            <button
              ref={viewerCloseRef}
              type="button"
              className="image-viewer-close"
              aria-label="Close image viewer"
              onClick={() => setViewerPath(null)}
            >
              ×
            </button>
            <ImageViewer path={viewerPath} />
          </section>
        </div>
      )}
    </div>
  );
}

function MessageImage({
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

function ImageViewer({ path }: { path: string }) {
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

function formatUploadSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}
