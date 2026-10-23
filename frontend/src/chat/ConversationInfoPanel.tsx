import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import type { Conversation, GroupConversation, Message } from "../types";
import { Avatar } from "./chat-utils";
import { PrivateImage } from "./PrivateImage";

export function ConversationInfoPanel({
  conversation,
  groupDetails,
  messages,
  loading,
  loadingMore,
  error,
  navigationError,
  hasMore,
  onClose,
  onRetry,
  onLoadMore,
  onOpenImage,
  onNavigateToMessage,
}: {
  conversation: Conversation;
  groupDetails?: GroupConversation;
  messages: Message[];
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  navigationError: string;
  hasMore: boolean;
  onClose: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpenImage: (path: string, message: Message, trigger: HTMLButtonElement) => void;
  onNavigateToMessage: (messageId: string) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const isGroup = conversation.kind === "group";
  const title = isGroup ? groupDetails?.name ?? conversation.name : conversation.otherUser.displayName;
  const photoUrl = isGroup ? groupDetails?.photoUrl ?? conversation.photoUrl : conversation.otherUser.avatarUrl;
  const bio = !isGroup ? conversation.otherUser.bio?.trim() : "";
  const images = messages.filter((message) =>
    message.type === "image" && !message.deletedAt && Boolean(message.image?.url));

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  return (
    <aside id="conversation-info-panel" className="conversation-info-panel" aria-labelledby="conversation-info-title">
      <header className="conversation-info-header">
        <h2 id="conversation-info-title">Conversation information</h2>
        <button
          ref={closeButton}
          type="button"
          className="conversation-info-close"
          aria-label="Close conversation information"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <section className="conversation-info-profile">
        <Avatar
          name={title}
          avatarUrl={photoUrl}
          className="conversation-info-avatar"
          fallback={isGroup ? "group" : "initial"}
        />
        <h3>{title}</h3>
        <p>{isGroup ? `${groupDetails?.members.length ?? 0} members` : bio || "No bio added yet."}</p>
      </section>
      <section className="conversation-info-media" aria-labelledby="shared-media-heading">
        <h3 id="shared-media-heading">Media</h3>
        {loading && <p className="muted-note" role="status">Loading shared photos...</p>}
        {error && (
          <div className="conversation-media-error" role="alert">
            <p>Shared photos could not be loaded.</p>
            <button type="button" className="quiet-button" onClick={onRetry}>Try again</button>
          </div>
        )}
        {navigationError && <p className="conversation-media-navigation-error" role="status">{navigationError}</p>}
        {!loading && !error && images.length === 0 && (
          <p className="muted-note" role="status">No shared photos yet</p>
        )}
        {images.length > 0 && (
          <div className="shared-media-grid">
            {images.map((message) => (
              <article className="shared-media-item" key={message.id}>
                <PrivateImage
                  path={message.image!.url}
                  alt={message.text || "Shared photo"}
                  onOpen={(path, trigger) => onOpenImage(path, message, trigger)}
                />
                <button
                  type="button"
                  className="shared-media-message-link"
                  onClick={() => onNavigateToMessage(message.id)}
                >
                  View message
                </button>
              </article>
            ))}
          </div>
        )}
        {!error && hasMore && (
          <button
            type="button"
            className="quiet-button shared-media-more"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        )}
      </section>
    </aside>
  );
}
