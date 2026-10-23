import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, FileText, Image as ImageIcon, Paperclip, Pin } from "lucide-react";

import type { Conversation, GroupConversation, Message } from "../types";
import { Avatar } from "./chat-utils";
import { PrivateImage } from "./PrivateImage";

type PanelView = "overview" | "pinned" | "media" | "files";

export function ConversationInfoPanel({
  conversation,
  groupDetails,
  messages,
  files,
  pinnedMessages,
  loading,
  loadingMore,
  error,
  navigationError,
  hasMore,
  onRetry,
  onLoadMore,
  filesLoading,
  filesLoadingMore,
  filesError,
  filesHasMore,
  onRetryFiles,
  onLoadMoreFiles,
  pinsLoading,
  pinsLoadingMore,
  pinsError,
  pinsHasMore,
  onRetryPins,
  onLoadMorePins,
  onOpenImage,
  onNavigateToMessage,
}: {
  conversation: Conversation;
  groupDetails?: GroupConversation;
  messages: Message[];
  files: Message[];
  pinnedMessages: Message[];
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  navigationError: string;
  hasMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  filesLoading: boolean;
  filesLoadingMore: boolean;
  filesError: boolean;
  filesHasMore: boolean;
  onRetryFiles: () => void;
  onLoadMoreFiles: () => void;
  pinsLoading: boolean;
  pinsLoadingMore: boolean;
  pinsError: boolean;
  pinsHasMore: boolean;
  onRetryPins: () => void;
  onLoadMorePins: () => void;
  onOpenImage: (path: string, message: Message, trigger: HTMLButtonElement) => void;
  onNavigateToMessage: (messageId: string) => void;
}) {
  const [view, setView] = useState<PanelView>("overview");
  const [chatInfoExpanded, setChatInfoExpanded] = useState(false);
  const [mediaFilesExpanded, setMediaFilesExpanded] = useState(false);
  const isGroup = conversation.kind === "group";
  const title = isGroup ? groupDetails?.name ?? conversation.name : conversation.otherUser.displayName;
  const photoUrl = isGroup ? groupDetails?.photoUrl ?? conversation.photoUrl : conversation.otherUser.avatarUrl;
  const bio = !isGroup ? conversation.otherUser.bio?.trim() : "";
  const images = messages.filter((message) =>
    message.type === "image" && !message.deletedAt && Boolean(message.image?.url));
  const availableFiles = files.filter((message) =>
    message.type === "file" && !message.deletedAt && Boolean(message.file?.url));

  useEffect(() => {
    setView("overview");
    setChatInfoExpanded(false);
    setMediaFilesExpanded(false);
  }, [conversation.id]);

  return (
    <aside id="conversation-info-panel" className="conversation-info-panel" aria-labelledby="conversation-info-title">
      <header className="conversation-info-header">
        {view === "overview" ? (
          <h2 id="conversation-info-title">Conversation information</h2>
        ) : (
          <>
            <button
              type="button"
              className="conversation-info-back"
              onClick={() => setView("overview")}
              aria-label="Back to conversation information"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <h2 id="conversation-info-title">
              {view === "pinned" ? "Pinned messages" : view === "media" ? "Media" : "Files"}
            </h2>
          </>
        )}
      </header>
      {view === "overview" ? (
        <>
          <div className="conversation-info-profile">
            <Avatar
              name={title}
              avatarUrl={photoUrl}
              className="conversation-info-avatar"
              fallback={isGroup ? "group" : "initial"}
            />
            <h3>{title}</h3>
            <p>{isGroup ? `${groupDetails?.members.length ?? 0} members` : bio || "No bio added yet."}</p>
          </div>
          <section className="conversation-info-section">
            <button
              type="button"
              className="conversation-info-section-toggle"
              aria-expanded={chatInfoExpanded}
              aria-controls="conversation-chat-info"
              onClick={() => setChatInfoExpanded((expanded) => !expanded)}
            >
              <span>Chat info</span>
              {chatInfoExpanded ? <ChevronUp size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
            </button>
            {chatInfoExpanded && (
              <div id="conversation-chat-info">
                <button
                  type="button"
                  className="conversation-info-navigation-row"
                  onClick={() => setView("pinned")}
                >
                  <Pin size={19} aria-hidden="true" />
                  <span>View pinned messages</span>
                </button>
              </div>
            )}
          </section>
          <section className="conversation-info-section">
            <button
              type="button"
              className="conversation-info-section-toggle"
              aria-expanded={mediaFilesExpanded}
              aria-controls="conversation-media-files"
              onClick={() => setMediaFilesExpanded((expanded) => !expanded)}
            >
              <span>Media &amp; files</span>
              {mediaFilesExpanded ? <ChevronUp size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
            </button>
            {mediaFilesExpanded && (
              <div id="conversation-media-files" className="conversation-info-navigation">
                <button type="button" className="conversation-info-navigation-row" onClick={() => setView("media")}>
                  <ImageIcon size={19} aria-hidden="true" />
                  <span>Media</span>
                </button>
                <button type="button" className="conversation-info-navigation-row" onClick={() => setView("files")}>
                  <Paperclip size={19} aria-hidden="true" />
                  <span>Files</span>
                </button>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="conversation-info-destination">
          {view === "pinned" && (
            <>
              {navigationError && <p className="conversation-media-navigation-error" role="status">{navigationError}</p>}
              {pinsLoading && <p className="muted-note" role="status">Loading pinned messages...</p>}
              {pinsError && (
                <div className="conversation-media-error" role="alert">
                  <p>Pinned messages could not be loaded.</p>
                  <button type="button" className="quiet-button" onClick={onRetryPins}>Try again</button>
                </div>
              )}
              {!pinsLoading && !pinsError && pinnedMessages.length === 0 && (
                <p className="muted-note" role="status">No pinned messages yet</p>
              )}
              {!pinsError && pinnedMessages.map((message) => {
                const preview = getPinnedMessagePreview(message);
                return (
                  <button
                    key={message.id}
                    type="button"
                    className="conversation-info-navigation-row pinned-message-destination-row"
                    aria-label={`Go to pinned message: ${preview}`}
                    onClick={() => onNavigateToMessage(message.id)}
                  >
                    <Pin size={17} aria-hidden="true" />
                    <span>{preview}</span>
                  </button>
                );
              })}
              {pinsHasMore && (
                <button type="button" className="quiet-button shared-media-more" onClick={onLoadMorePins} disabled={pinsLoadingMore}>
                  {pinsLoadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </>
          )}
          {view === "media" && (
            <>
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
                <button type="button" className="quiet-button shared-media-more" onClick={onLoadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </>
          )}
          {view === "files" && (
            <>
              {filesLoading && <p className="muted-note" role="status">Loading shared files...</p>}
              {filesError && (
                <div className="conversation-media-error" role="alert">
                  <p>Shared files could not be loaded.</p>
                  <button type="button" className="quiet-button" onClick={onRetryFiles}>Try again</button>
                </div>
              )}
              {!filesLoading && !filesError && availableFiles.length === 0 && (
                <p className="muted-note" role="status">No shared files yet</p>
              )}
              {availableFiles.map((message) => (
                <article className="conversation-info-file" key={message.id}>
                  <FileText size={19} aria-hidden="true" />
                  <div className="conversation-info-file-details">
                    <span className="conversation-info-file-name" title={message.file!.filename}>{message.file!.filename}</span>
                    <span>{formatFileSize(message.file!.size)}</span>
                    <button
                      type="button"
                      className="shared-media-message-link"
                      onClick={() => onNavigateToMessage(message.id)}
                    >
                      View message
                    </button>
                  </div>
                  <a
                    className="conversation-info-file-download"
                    href={message.file!.url}
                    aria-label={`Download ${message.file!.filename}`}
                  >
                    Download
                  </a>
                </article>
              ))}
              {!filesError && filesHasMore && (
                <button type="button" className="quiet-button shared-media-more" onClick={onLoadMoreFiles} disabled={filesLoadingMore}>
                  {filesLoadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </>
          )}
        </section>
      )}
    </aside>
  );
}

function getPinnedMessagePreview(message: Message): string {
  if (message.deletedAt) return "This message was deleted.";
  if (message.type === "image") return "Pinned image";
  if (message.type === "file") return "Pinned file";
  const text = message.text.replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > 120 ? `${characters.slice(0, 117).join("")}...` : text || "Pinned message";
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
