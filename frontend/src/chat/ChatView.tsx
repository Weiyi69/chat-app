import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { chatApi } from "../lib/api";
import type { Conversation, GroupConversation, MessagePage, ReadPosition } from "../types";
import { Avatar, formatDate, formatTime, mergeMessages } from "./chat-utils";

export function ChatView({
  conversation,
  currentUserId,
  messagesQuery,
  socketConnected,
  conversationJoined,
  socketError,
  onBack,
  onSend,
  onSendImage,
  onMarkRead,
}: {
  conversation: Conversation;
  currentUserId: string;
  messagesQuery: UseQueryResult<MessagePage, Error>;
  socketConnected: boolean;
  conversationJoined: boolean;
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
  onMarkRead: (messageId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [imageRetryAvailable, setImageRetryAvailable] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupMemberSearch, setGroupMemberSearch] = useState("");
  const [groupActionError, setGroupActionError] = useState("");
  const [groupActionBusy, setGroupActionBusy] = useState(false);
  const [groupPhotoFile, setGroupPhotoFile] = useState<File | null>(null);
  const [groupPhotoPreviewUrl, setGroupPhotoPreviewUrl] = useState<string | null>(null);
  const [groupPhotoProgress, setGroupPhotoProgress] = useState(0);
  const [groupPhotoOperation, setGroupPhotoOperation] = useState<"upload" | "remove" | null>(null);
  const [groupPhotoError, setGroupPhotoError] = useState("");
  const [groupPhotoSuccess, setGroupPhotoSuccess] = useState("");
  const [selectedReceiptMessageId, setSelectedReceiptMessageId] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const imageIdempotencyKey = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const viewerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReadAttemptRef = useRef<string | null>(null);
  const pendingReadRef = useRef<string | null>(null);
  const pinnedToBottom = useRef(true);
  const queryClient = useQueryClient();
  const imageLimitsQuery = useQuery({
    queryKey: ["image-limits"],
    queryFn: chatApi.imageLimits,
    staleTime: Infinity,
  });
  const isGroup = conversation.kind === "group";
  const groupPhotoLimitsQuery = useQuery({
    queryKey: ["group-photo-limits"],
    queryFn: chatApi.groupPhotoLimits,
    staleTime: Infinity,
    enabled: isGroup,
  });
  const groupQuery = useQuery({
    queryKey: ["group", conversation.id],
    queryFn: () => chatApi.groupDetails(conversation.id),
    enabled: isGroup,
    initialData: isGroup ? conversation : undefined,
  });
  const groupMemberSearchQuery = useQuery({
    queryKey: ["group-member-search", groupMemberSearch],
    queryFn: () => chatApi.searchUsers(groupMemberSearch, undefined),
    enabled: isGroup && groupDetailsOpen && groupQuery.data?.currentRole === "admin" && groupMemberSearch.trim().length >= 2,
  });
  const groupDetails = isGroup ? groupQuery.data : undefined;
  const groupPhotoUrl = groupDetails ? groupDetails.photoUrl : isGroup ? conversation.photoUrl : null;
  const page = messagesQuery.data;
  const messages = page?.messages ?? [];
  const receiptsQuery = useQuery({
    queryKey: ["receipts", conversation.id],
    queryFn: () => chatApi.receipts(conversation.id),
  });
  const readersQuery = useQuery({
    queryKey: ["message-readers", conversation.id, selectedReceiptMessageId],
    queryFn: () => chatApi.messageReaders(conversation.id, selectedReceiptMessageId!),
    enabled: isGroup && Boolean(selectedReceiptMessageId),
  });

  useEffect(() => {
    pinnedToBottom.current = true;
    lastReadAttemptRef.current = null;
    pendingReadRef.current = null;
    setSelectedReceiptMessageId(null);
    setReceiptError("");
  }, [conversation.id]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container && pinnedToBottom.current) container.scrollTop = container.scrollHeight;
    markLatestVisibleMessageRead();
  }, [messages, socketConnected, conversationJoined]);

  useEffect(() => {
    const onVisibilityChange = () => markLatestVisibleMessageRead();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [conversation.id, messages, socketConnected, conversationJoined]);

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

  useEffect(() => {
    if (!groupPhotoFile) {
      setGroupPhotoPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(groupPhotoFile);
    setGroupPhotoPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [groupPhotoFile]);

  useEffect(() => {
    setGroupPhotoFile(null);
    setGroupPhotoError("");
    setGroupPhotoSuccess("");
    setGroupPhotoProgress(0);
  }, [conversation.id]);

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

  async function updateGroup(action: () => Promise<GroupConversation>) {
    setGroupActionBusy(true);
    setGroupActionError("");
    try {
      const updated = await action();
      queryClient.setQueryData(["group", conversation.id], updated);
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (error) {
      setGroupActionError(error instanceof Error ? error.message : "Group could not be updated.");
    } finally {
      setGroupActionBusy(false);
    }
  }

  function updateGroupPhotoCache(updated: GroupConversation) {
    queryClient.setQueryData(["group", conversation.id], updated);
    queryClient.setQueryData<Conversation[]>(["conversations"], (current) =>
      current?.map((item) => item.id === updated.id ? updated : item),
    );
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }

  function selectGroupPhoto(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!selected) return;
    const maxBytes = groupPhotoLimitsQuery.data?.maxUploadBytes ?? 5 * 1024 * 1024;
    setGroupPhotoError("");
    setGroupPhotoSuccess("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type)) {
      setGroupPhotoFile(null);
      setGroupPhotoError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (selected.size > maxBytes) {
      setGroupPhotoFile(null);
      setGroupPhotoError(`Choose an image smaller than ${formatUploadSize(maxBytes)}.`);
      return;
    }
    setGroupPhotoFile(selected);
    setGroupPhotoProgress(0);
  }

  async function saveGroupPhoto() {
    if (!groupPhotoFile || groupPhotoOperation) return;
    setGroupPhotoOperation("upload");
    setGroupPhotoError("");
    setGroupPhotoSuccess("");
    try {
      const updated = await chatApi.uploadGroupPhoto(
        conversation.id,
        groupPhotoFile,
        setGroupPhotoProgress,
      );
      updateGroupPhotoCache(updated);
      setGroupPhotoFile(null);
      setGroupPhotoProgress(0);
      setGroupPhotoSuccess("Group photo updated.");
    } catch (error) {
      setGroupPhotoError(error instanceof Error ? error.message : "Group photo could not be saved. Try again.");
    } finally {
      setGroupPhotoOperation(null);
    }
  }

  async function removeCurrentGroupPhoto() {
    if (!groupPhotoUrl || groupPhotoOperation) return;
    setGroupPhotoOperation("remove");
    setGroupPhotoError("");
    setGroupPhotoSuccess("");
    try {
      const updated = await chatApi.removeGroupPhoto(conversation.id);
      updateGroupPhotoCache(updated);
      setGroupPhotoFile(null);
      setGroupPhotoProgress(0);
      setGroupPhotoSuccess("Group photo removed.");
    } catch (error) {
      setGroupPhotoError(error instanceof Error ? error.message : "Group photo could not be removed. Try again.");
    } finally {
      setGroupPhotoOperation(null);
    }
  }

  function cancelGroupPhotoSelection() {
    setGroupPhotoFile(null);
    setGroupPhotoProgress(0);
    setGroupPhotoError("");
  }

  async function leaveGroup() {
    setGroupActionBusy(true);
    setGroupActionError("");
    try {
      await chatApi.leaveGroup(conversation.id);
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setGroupDetailsOpen(false);
      onBack();
    } catch (error) {
      setGroupActionError(error instanceof Error ? error.message : "Could not leave the group.");
      setGroupActionBusy(false);
    }
  }

  const title = isGroup ? conversation.name : conversation.otherUser.displayName;
  const maxGroupPhotoBytes = groupPhotoLimitsQuery.data?.maxUploadBytes ?? 5 * 1024 * 1024;
  const lastMessage = messages.at(-1);

  function markLatestVisibleMessageRead() {
    if (
      !socketConnected ||
      !conversationJoined ||
      document.visibilityState !== "visible" ||
      !lastMessage ||
      lastReadAttemptRef.current === lastMessage.id ||
      pendingReadRef.current === lastMessage.id
    ) return;
    const container = scrollRef.current;
    if (!container || container.scrollHeight - container.scrollTop - container.clientHeight >= 80) return;
    pendingReadRef.current = lastMessage.id;
    void onMarkRead(lastMessage.id).then(() => {
      lastReadAttemptRef.current = lastMessage.id;
      pendingReadRef.current = null;
      setReceiptError("");
      void queryClient.invalidateQueries({ queryKey: ["receipts", conversation.id] });
    }).catch(() => {
      pendingReadRef.current = null;
      setReceiptError("Read status could not be synchronized. It will retry when the chat is viewed again.");
    });
  }

  const recipientPosition = receiptsQuery.data?.find((position) => position.userId !== currentUserId);
  const isAtOrBeforePosition = (message: { id: string; createdAt: string }, position: ReadPosition) => {
    const messageTime = new Date(message.createdAt).getTime();
    const positionTime = new Date(position.createdAt).getTime();
    return messageTime < positionTime ||
      (messageTime === positionTime && message.id <= position.messageId);
  };
  const latestReadOwnMessage = !isGroup && recipientPosition
    ? [...messages].reverse().find((message) =>
        message.senderId === currentUserId && isAtOrBeforePosition(message, recipientPosition),
      )
    : undefined;
  const latestSentOwnMessage = [...messages].reverse().find(
    (message) => message.senderId === currentUserId,
  );

  return (
    <div className="chat-view">
      <header className="chat-header">
        <button type="button" className="back-button" onClick={onBack} aria-label="Back to conversations">
          ←
        </button>
        <Avatar
          name={title}
          avatarUrl={isGroup ? groupPhotoUrl : conversation.otherUser.avatarUrl}
          className="large"
          fallback={isGroup ? "group" : "initial"}
        />
        <div className="chat-contact">
          <h2>{title}</h2>
          <span>
            <span className={`status-dot ${socketConnected ? "online" : ""}`} />
            {isGroup
              ? `${groupDetails?.members.length ?? 0} members`
              : socketConnected ? "Available" : "Reconnecting"}
          </span>
        </div>
        {isGroup && (
          <button
            type="button"
            className="quiet-button group-details-button"
            onClick={() => {
              setGroupDetailsOpen(true);
              setGroupNameDraft(groupDetails?.name ?? conversation.name);
              setGroupActionError("");
            }}
          >
            Group details
          </button>
        )}
        <div className="chat-header-mark" aria-hidden="true">C</div>
      </header>

      {isGroup && groupDetailsOpen && (
        <div className="group-details-backdrop">
          <section className="group-details-dialog" role="dialog" aria-modal="true" aria-labelledby="group-details-title">
            <header className="group-details-heading">
              <div>
                <span className="eyebrow">CONVERSATION</span>
                <h2 id="group-details-title">Group details</h2>
              </div>
              <button
                type="button"
                className="quiet-button"
                onClick={() => setGroupDetailsOpen(false)}
              >
                Close
              </button>
            </header>
            {groupQuery.isLoading && <p className="muted-note">Loading group details...</p>}
            {groupQuery.error && (
              <div className="error-panel">
                <p>Group details could not be loaded.</p>
                <button type="button" className="quiet-button" onClick={() => void groupQuery.refetch()}>
                  Try again
                </button>
              </div>
            )}
            {groupDetails && (
              <>
                <section className="group-photo-editor" aria-label="Group photo">
                  {groupPhotoPreviewUrl ? (
                    <div className="avatar large group-photo-preview">
                      <img src={groupPhotoPreviewUrl} alt="Preview of selected group photo" />
                    </div>
                  ) : (
                    <Avatar
                      name={groupDetails.name}
                      avatarUrl={groupDetails.photoUrl}
                      className="large"
                      fallback="group"
                    />
                  )}
                  <div className="group-photo-controls">
                    <strong>{groupPhotoFile ? "Photo preview" : "Group photo"}</strong>
                    {groupDetails.currentRole === "admin" && (
                      <label className="quiet-button group-photo-picker">
                        <span>{groupPhotoFile || groupDetails.photoUrl ? "Choose a different photo" : "Choose a photo"}</span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          aria-label="Choose a group photo"
                          onChange={selectGroupPhoto}
                          disabled={groupPhotoOperation !== null}
                        />
                      </label>
                    )}
                    <span className="muted-note">
                      JPEG, PNG, or WebP. Maximum {formatUploadSize(maxGroupPhotoBytes)}.
                    </span>
                  </div>
                </section>
                {groupPhotoOperation === "upload" && (
                  <div className="group-photo-progress">
                    <progress aria-label="Group photo upload progress" max={100} value={groupPhotoProgress} />
                    <span role="status">Uploading photo: {groupPhotoProgress}%</span>
                  </div>
                )}
                {groupPhotoLimitsQuery.error && (
                  <p className="muted-note" role="status">
                    Upload limits are unavailable; the server will validate the photo.
                  </p>
                )}
                {groupPhotoError && <p className="inline-error" role="alert">{groupPhotoError}</p>}
                {groupPhotoSuccess && <p className="group-photo-success" role="status">{groupPhotoSuccess}</p>}
                {groupDetails.currentRole === "admin" && (
                  <div className="group-photo-actions">
                    {groupPhotoFile && (
                      <>
                        <button
                          type="button"
                          className="quiet-button"
                          onClick={cancelGroupPhotoSelection}
                          disabled={groupPhotoOperation !== null}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="primary-button group-photo-save"
                          onClick={() => void saveGroupPhoto()}
                          disabled={groupPhotoOperation !== null}
                        >
                          {groupPhotoOperation === "upload" ? "Saving..." : "Save photo"}
                        </button>
                      </>
                    )}
                    {groupDetails.photoUrl && !groupPhotoFile && (
                      <button
                        type="button"
                        className="quiet-button danger-button"
                        onClick={() => void removeCurrentGroupPhoto()}
                        disabled={groupPhotoOperation !== null}
                      >
                        {groupPhotoOperation === "remove" ? "Removing..." : "Remove photo"}
                      </button>
                    )}
                  </div>
                )}
                {groupDetails.currentRole === "admin" ? (
                  <form
                    className="group-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void updateGroup(() => chatApi.renameGroup(conversation.id, groupNameDraft.trim()));
                    }}
                  >
                    <label htmlFor="group-name">Group name</label>
                    <div className="group-inline-action">
                      <input
                        id="group-name"
                        value={groupNameDraft}
                        maxLength={80}
                        onChange={(event) => setGroupNameDraft(event.target.value)}
                      />
                      <button
                        type="submit"
                        className="quiet-button"
                        disabled={groupActionBusy || !groupNameDraft.trim()}
                      >
                        Rename
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="group-details-name">{groupDetails.name}</p>
                )}
                <h3>Members ({groupDetails.members.length})</h3>
                <ul className="group-member-list">
                  {groupDetails.members.map((member) => (
                    <li key={member.userId}>
                      <Avatar name={member.displayName} avatarUrl={member.avatarUrl} />
                      <span className="group-member-name">
                        {member.displayName}
                        {member.userId === currentUserId ? " (you)" : ""}
                      </span>
                      <span className="group-member-role">{member.role}</span>
                      {groupDetails.currentRole === "admin" && member.userId !== currentUserId && (
                        <button
                          type="button"
                          className="quiet-button"
                          disabled={groupActionBusy}
                          onClick={() => void updateGroup(() =>
                            chatApi.removeGroupMember(conversation.id, member.userId))}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {groupDetails.currentRole === "admin" && (
                  <div className="group-add-members">
                    <label htmlFor="group-member-search">Add people</label>
                    <input
                      id="group-member-search"
                      value={groupMemberSearch}
                      onChange={(event) => setGroupMemberSearch(event.target.value)}
                      placeholder="Find someone..."
                    />
                    {groupMemberSearch.trim().length >= 2 && (
                      <div className="group-member-search-results">
                        {groupMemberSearchQuery.isLoading && <p className="muted-note">Searching...</p>}
                        {groupMemberSearchQuery.error && (
                          <p className="inline-error">People search is unavailable.</p>
                        )}
                        {groupMemberSearchQuery.data?.users.map((person) => {
                          const alreadyMember = groupDetails.members.some((member) => member.userId === person.id);
                          return (
                            <button
                              key={person.id}
                              type="button"
                              className="person-result"
                              disabled={alreadyMember || groupActionBusy}
                              onClick={() => void updateGroup(() =>
                                chatApi.addGroupMembers(conversation.id, [person.id]))}
                            >
                              <Avatar name={person.displayName} avatarUrl={person.avatarUrl} />
                              <span>{person.displayName}</span>
                              <span className="result-action">{alreadyMember ? "Added" : "+"}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {groupActionError && <p className="inline-error" role="alert">{groupActionError}</p>}
                <button
                  type="button"
                  className="quiet-button group-leave-button"
                  disabled={groupActionBusy}
                  onClick={() => void leaveGroup()}
                >
                  Leave group
                </button>
              </>
            )}
          </section>
        </div>
      )}

      {socketError && <p className="connection-banner" role="status">{socketError}</p>}

      <div
        className="message-history"
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          pinnedToBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          markLatestVisibleMessageRead();
        }}
        aria-live="polite"
        aria-label={isGroup ? `Messages in ${conversation.name}` : `Messages with ${conversation.otherUser.displayName}`}
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
              name={title}
              avatarUrl={isGroup ? groupPhotoUrl : conversation.otherUser.avatarUrl}
              className="large"
              fallback={isGroup ? "group" : "initial"}
            />
            <h3>{isGroup ? `Say hello to ${conversation.name}.` : `Say hello to ${conversation.otherUser.displayName.split(" ")[0]}.`}</h3>
            <p>This is the beginning of your conversation.</p>
          </div>
        )}
        {messages.map((message, index) => {
          const own = message.senderId === currentUserId;
          const image = message.image;
          const groupMember = groupDetails?.members.find((member) => member.userId === message.senderId);
          const senderName = message.sender?.displayName ?? groupMember?.displayName ??
            (isGroup ? "Group member" : conversation.otherUser.displayName);
          const senderAvatar = message.sender?.avatarUrl ?? groupMember?.avatarUrl ??
            (isGroup ? null : conversation.otherUser.avatarUrl);
          const showDate =
            index === 0 ||
            new Date(messages[index - 1].createdAt).toDateString() !==
              new Date(message.createdAt).toDateString();
          return (
            <div key={message.id}>
              {showDate && <div className="date-divider">{formatDate(message.createdAt)}</div>}
              <div className={`message-row ${own ? "own" : ""}`}>
                {!own && (
                  <Avatar name={senderName} avatarUrl={senderAvatar} />
                )}
                <div className={`message-content ${own ? "own" : ""}`}>
                  {isGroup && <span className="group-message-sender">{senderName}</span>}
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
                  {own && !isGroup && latestReadOwnMessage?.id === message.id && (
                    <span className="message-receipt" aria-label="Read by recipient">Seen</span>
                  )}
                  {own && latestSentOwnMessage?.id === message.id &&
                    (isGroup || latestReadOwnMessage?.id !== message.id) && (
                    <span className="message-receipt" aria-label="Message saved">Sent</span>
                  )}
                  {own && isGroup && (
                    <div className="message-reader-details">
                      <button
                        type="button"
                        className="message-readers-toggle"
                        aria-expanded={selectedReceiptMessageId === message.id}
                        aria-controls={`message-readers-${message.id}`}
                        onClick={() => setSelectedReceiptMessageId(
                          selectedReceiptMessageId === message.id ? null : message.id,
                        )}
                      >
                        Seen by
                      </button>
                      {selectedReceiptMessageId === message.id && (
                        <div className="message-readers" id={`message-readers-${message.id}`}>
                          {readersQuery.isLoading && <span>Loading readers...</span>}
                          {readersQuery.error && (
                            <span role="status">Reader list unavailable.</span>
                          )}
                          {readersQuery.data && (
                            readersQuery.data.length
                              ? <span>Seen by {readersQuery.data.map((reader) => reader.displayName).join(", ")}</span>
                              : <span>No one has read this message yet.</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {isGroup && own && <Avatar name={senderName} avatarUrl={senderAvatar} />}
              </div>
            </div>
          );
        })}
      </div>

      {(receiptError || receiptsQuery.error) && (
        <p className="receipt-error" role="status">
          {receiptError || "Read status could not be loaded."}
        </p>
      )}

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
