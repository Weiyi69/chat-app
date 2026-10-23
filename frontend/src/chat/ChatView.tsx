import { useInfiniteQuery, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { Info } from "lucide-react";

import { chatApi } from "../lib/api";
import type { Conversation, GroupConversation, Message, MessagePage, ReadPosition } from "../types";
import { Avatar, formatDate, formatTime, mergeMessages } from "./chat-utils";
import { ConversationInfoPanel } from "./ConversationInfoPanel";
import { PrivateImage, PrivateImageViewer } from "./PrivateImage";

export function ChatView({
  conversation,
  conversations,
  currentUserId,
  messagesQuery,
  socketConnected,
  conversationJoined,
  socketError,
  onBack,
  onSend,
  onSendImage,
  onMarkRead,
  onEditMessage,
  onDeleteMessage,
  onPinMessage,
  onForwardMessage,
}: {
  conversation: Conversation;
  conversations: Conversation[];
  currentUserId: string;
  messagesQuery: UseQueryResult<MessagePage, Error>;
  socketConnected: boolean;
  conversationJoined: boolean;
  socketError: string;
  onBack: () => void;
  onSend: (text: string, clientId: string, replyToMessageId?: string) => Promise<void>;
  onSendImage: (
    file: File,
    caption: string,
    clientId: string,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    replyToMessageId?: string,
  ) => Promise<void>;
  onMarkRead: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, revision: number) => Promise<unknown>;
  onDeleteMessage: (messageId: string, revision: number) => Promise<unknown>;
  onPinMessage: (messageId: string, pinned: boolean) => Promise<void>;
  onForwardMessage: (messageId: string, destinationConversationId: string, clientId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [imageRetryAvailable, setImageRetryAvailable] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [viewerMessageId, setViewerMessageId] = useState<string | null>(null);
  const [conversationInfoOpen, setConversationInfoOpen] = useState(false);
  const [mediaNavigationError, setMediaNavigationError] = useState("");
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmDeleteMessageId, setConfirmDeleteMessageId] = useState<string | null>(null);
  const [messageActionBusy, setMessageActionBusy] = useState<string | null>(null);
  const [messageActionError, setMessageActionError] = useState("");
  const [messageActionErrorId, setMessageActionErrorId] = useState<string | null>(null);
  const [openMenuMessageId, setOpenMenuMessageId] = useState<string | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [replyNavigationError, setReplyNavigationError] = useState("");
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [forwardMessageId, setForwardMessageId] = useState<string | null>(null);
  const [forwardDestinationId, setForwardDestinationId] = useState("");
  const [forwardClientId, setForwardClientId] = useState("");
  const [forwardBusy, setForwardBusy] = useState(false);
  const [forwardError, setForwardError] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const imageIdempotencyKey = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const viewerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const conversationInfoTriggerRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const forwardDialogRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
  const sharedMediaQuery = useInfiniteQuery({
    queryKey: ["shared-media", conversation.id],
    queryFn: ({ pageParam }) => chatApi.sharedMedia(conversation.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: conversationInfoOpen,
    retry: false,
  });
  const sharedMediaMessages = sharedMediaQuery.data?.pages.flatMap((page) => page.messages) ?? [];
  const groupMemberSearchQuery = useQuery({
    queryKey: ["group-member-search", groupMemberSearch],
    queryFn: () => chatApi.searchUsers(groupMemberSearch, undefined),
    enabled: isGroup && groupDetailsOpen && groupQuery.data?.currentRole === "admin" && groupMemberSearch.trim().length >= 2,
  });
  const groupDetails = isGroup ? groupQuery.data : undefined;
  const groupPhotoUrl = groupDetails ? groupDetails.photoUrl : isGroup ? conversation.photoUrl : null;
  const page = messagesQuery.data;
  const messages = page?.messages ?? [];
  const replyTarget = messages.find((message) => message.id === replyToMessageId);
  const forwardTarget = messages.find((message) => message.id === forwardMessageId);
  const forwardDestinations = conversations.filter((item) => item.id !== conversation.id);
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
    setOpenMenuMessageId(null);
    setReplyToMessageId(null);
    setForwardMessageId(null);
    setForwardError("");
  }, [conversation.id]);

  useEffect(() => {
    if (!openMenuMessageId) return;
    const closeMenuOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpenMenuMessageId(null);
        moreTriggerRef.current?.focus();
      }
    };
    const closeMenuOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !moreMenuRef.current?.contains(target) &&
        !moreTriggerRef.current?.contains(target)
      ) {
        setOpenMenuMessageId(null);
      }
    };
    window.addEventListener("keydown", closeMenuOnEscape);
    document.addEventListener("pointerdown", closeMenuOutside);
    return () => {
      window.removeEventListener("keydown", closeMenuOnEscape);
      document.removeEventListener("pointerdown", closeMenuOutside);
    };
  }, [openMenuMessageId]);

  useEffect(() => {
    if (!forwardMessageId) return;
    requestAnimationFrame(() => {
      const firstControl = forwardDialogRef.current?.querySelector<HTMLElement>(
        "select, button:not(:disabled)",
      );
      (firstControl ?? forwardDialogRef.current)?.focus();
    });
  }, [forwardMessageId]);

  useEffect(() => {
    const viewerIsLoaded = messages.some((message) => message.image?.url === viewerPath) ||
      sharedMediaMessages.some((message) => message.image?.url === viewerPath);
    if (
      viewerPath &&
      !messagesQuery.isLoading &&
      !sharedMediaQuery.isLoading &&
      !viewerIsLoaded
    ) {
      setViewerPath(null);
      setViewerMessageId(null);
    }
  }, [messages, messagesQuery.isLoading, sharedMediaMessages, sharedMediaQuery.isLoading, viewerPath]);

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
      if (event.key === "Escape") {
        setViewerPath(null);
        setViewerMessageId(null);
      }
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

  useEffect(() => {
    setConversationInfoOpen(false);
    setViewerPath(null);
    setViewerMessageId(null);
    setMediaNavigationError("");
  }, [conversation.id]);

  useEffect(() => {
    if (!conversationInfoOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !viewerPath) {
        setConversationInfoOpen(false);
        conversationInfoTriggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [conversationInfoOpen, viewerPath]);

  function closeConversationInfo() {
    setConversationInfoOpen(false);
    requestAnimationFrame(() => conversationInfoTriggerRef.current?.focus());
  }

  async function navigateToMessage(messageId: string) {
    setMediaNavigationError("");
    try {
      let cursor = messagesQuery.data?.nextCursor ?? null;
      let found = messages.some((message) => message.id === messageId);
      while (cursor && !found) {
        const older = await chatApi.messages(conversation.id, cursor);
        queryClient.setQueryData<MessagePage>(["messages", conversation.id], (current) => ({
          messages: mergeMessages(older.messages, current?.messages ?? []),
          nextCursor: older.nextCursor,
        }));
        cursor = older.nextCursor;
        found = older.messages.some((message) => message.id === messageId);
      }
      if (!found) {
        setMediaNavigationError("The original message could not be found.");
        return;
      }
      setConversationInfoOpen(false);
      setViewerPath(null);
      setViewerMessageId(null);
      requestAnimationFrame(() => {
        const target = document.getElementById(`message-${messageId}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightedMessageId(messageId);
        window.setTimeout(() => setHighlightedMessageId((current) =>
          current === messageId ? null : current), 2000);
      });
    } catch {
      setMediaNavigationError("The original message could not be loaded.");
    }
  }

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
          replyToMessageId ?? undefined,
        );
        clearSelectedImage();
      } else {
        idempotencyKey.current ??= window.crypto.randomUUID();
        await onSend(text, idempotencyKey.current, replyToMessageId ?? undefined);
        idempotencyKey.current = null;
      }
      setDraft("");
      setReplyToMessageId(null);
      setReplyNavigationError("");
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

  async function saveMessageEdit(messageId: string) {
    const text = editDraft.trim();
    if (!text || text.length > 4000 || messageActionBusy) return;
    setMessageActionBusy(messageId);
    setMessageActionError("");
    try {
      const message = messages.find((item) => item.id === messageId);
      await onEditMessage(messageId, text, message?.revision ?? 0);
      setEditingMessageId(null);
      setEditDraft("");
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "Message could not be edited.");
      setMessageActionErrorId(messageId);
    } finally {
      setMessageActionBusy(null);
    }
  }

  async function confirmDeleteMessage(messageId: string) {
    if (messageActionBusy) return;
    setMessageActionBusy(messageId);
    setMessageActionError("");
    try {
      const message = messages.find((item) => item.id === messageId);
      await onDeleteMessage(messageId, message?.revision ?? 0);
      setConfirmDeleteMessageId(null);
      setEditingMessageId(null);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "Message could not be deleted.");
      setMessageActionErrorId(messageId);
    } finally {
      setMessageActionBusy(null);
    }
  }

  function getMessageSenderName(message: Message) {
    if (message.sender?.displayName) return message.sender.displayName;
    const member = isGroup
      ? groupDetails?.members.find((item) => item.userId === message.senderId)
      : undefined;
    return member?.displayName ?? (message.senderId === currentUserId ? "You" : "Conversation member");
  }

  function getReplyExcerpt(message: Message) {
    if (message.deletedAt) return "This message was deleted";
    if (message.type === "image") return message.text ? `Photo: ${message.text}` : "Photo";
    return message.text;
  }

  function startReply(message: Message) {
    idempotencyKey.current = null;
    imageIdempotencyKey.current = null;
    setImageRetryAvailable(false);
    setReplyToMessageId(message.id);
    setReplyNavigationError("");
    setOpenMenuMessageId(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function toggleMessageMenu(messageId: string, trigger: HTMLButtonElement) {
    moreTriggerRef.current = trigger;
    if (openMenuMessageId === messageId) {
      setOpenMenuMessageId(null);
      return;
    }
    setOpenMenuMessageId(messageId);
    requestAnimationFrame(() =>
      moreMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(),
    );
  }

  async function navigateToOriginal(messageId: string) {
    setReplyNavigationError("");
    let found = messages.some((message) => message.id === messageId);
    let cursor = page?.nextCursor ?? null;
    try {
      while (!found && cursor) {
        const older = await chatApi.messages(conversation.id, cursor);
        queryClient.setQueryData<MessagePage>(["messages", conversation.id], (current) => ({
          messages: mergeMessages(older.messages, current?.messages ?? []),
          nextCursor: older.nextCursor,
        }));
        found = older.messages.some((message) => message.id === messageId);
        cursor = older.nextCursor;
        pinnedToBottom.current = false;
      }
      if (!found) {
        setReplyNavigationError("The original message is no longer available.");
        return;
      }
      requestAnimationFrame(() => {
        const target = document.getElementById(`message-${messageId}`);
        target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        setHighlightedMessageId(messageId);
        window.setTimeout(() => setHighlightedMessageId(null), 1800);
      });
    } catch {
      setReplyNavigationError("The original message could not be opened.");
    }
  }

  async function togglePin(message: Message) {
    if (messageActionBusy) return;
    setMessageActionBusy(message.id);
    setMessageActionError("");
    setMessageActionErrorId(null);
    setOpenMenuMessageId(null);
    try {
      await onPinMessage(message.id, !message.pinnedAt);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "Pin status could not be updated.");
      setMessageActionErrorId(message.id);
    } finally {
      setMessageActionBusy(null);
    }
  }

  async function forwardSelectedMessage() {
    if (!forwardMessageId || !forwardDestinationId || forwardBusy || !forwardClientId) return;
    setForwardBusy(true);
    setForwardError("");
    try {
      await onForwardMessage(forwardMessageId, forwardDestinationId, forwardClientId);
      setForwardMessageId(null);
      setForwardDestinationId("");
      setForwardClientId("");
    } catch (error) {
      setForwardError(error instanceof Error ? error.message : "Message could not be forwarded.");
    } finally {
      setForwardBusy(false);
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (!items.length) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  function handleForwardDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !forwardBusy) {
      event.preventDefault();
      setForwardMessageId(null);
      requestAnimationFrame(() => moreTriggerRef.current?.focus());
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "select:not(:disabled), button:not(:disabled)",
      ),
    );
    if (!controls.length) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
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
        message.senderId === currentUserId &&
        !message.deletedAt &&
        isAtOrBeforePosition(message, recipientPosition),
      )
    : undefined;
  const latestSentOwnMessage = [...messages].reverse().find(
    (message) => message.senderId === currentUserId && !message.deletedAt,
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
        <button
          ref={conversationInfoTriggerRef}
          type="button"
          className="chat-header-info-button"
          aria-label="Conversation information"
          aria-controls="conversation-info-panel"
          aria-expanded={conversationInfoOpen}
          onClick={() => {
            setMediaNavigationError("");
            setConversationInfoOpen(true);
          }}
        >
          <Info size={19} aria-hidden="true" />
        </button>
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

      <div className={`chat-content ${conversationInfoOpen ? "conversation-info-open" : ""}`}>
        <div className="chat-main-column">
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
          const deleted = Boolean(message.deletedAt);
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
              <div
                id={`message-${message.id}`}
                className={`message-row ${own ? "own" : ""} ${highlightedMessageId === message.id ? "highlighted" : ""}`}
              >
                {!own && (
                  <Avatar name={senderName} avatarUrl={senderAvatar} />
                )}
                {own && (
                  <MessageActionToolbar
                    message={message}
                    own={own}
                    deleted={deleted}
                    menuOpen={openMenuMessageId === message.id}
                    busy={messageActionBusy !== null}
                    menuRef={moreMenuRef}
                    onReply={() => startReply(message)}
                    onToggleMenu={(button) => toggleMessageMenu(message.id, button)}
                    onEdit={() => {
                      setOpenMenuMessageId(null);
                      setEditingMessageId(message.id);
                      setEditDraft(message.text);
                      setConfirmDeleteMessageId(null);
                      setMessageActionError("");
                    }}
                    onUnsend={() => {
                      setOpenMenuMessageId(null);
                      setConfirmDeleteMessageId(message.id);
                      setMessageActionError("");
                    }}
                    onPin={() => void togglePin(message)}
                    onForward={() => {
                      setOpenMenuMessageId(null);
                      setForwardMessageId(message.id);
                      setForwardDestinationId(forwardDestinations[0]?.id ?? "");
                      setForwardClientId(window.crypto.randomUUID());
                      setForwardError("");
                    }}
                    onMenuKeyDown={handleMenuKeyDown}
                    hasDestinations={forwardDestinations.length > 0}
                  />
                )}
                <div className={`message-content ${own ? "own" : ""}`}>
                  {isGroup && <span className="group-message-sender">{senderName}</span>}
                  {message.forwardedFrom && !deleted && (
                    <span className="forwarded-attribution">
                      Forwarded from {message.forwardedFrom.senderName}
                    </span>
                  )}
                  {message.reply && (
                    <button
                      type="button"
                      className="message-reply-preview"
                      onClick={() => void navigateToOriginal(message.reply!.id)}
                      aria-label={`Go to reply target from ${message.reply.senderName}: ${message.reply.text || (message.reply.type === "image" ? "Photo" : "Message")}`}
                    >
                      <span>{message.reply.senderName}</span>
                      <span>{message.reply.text || (message.reply.type === "image" ? "Photo" : "Message")}</span>
                    </button>
                  )}
                  {editingMessageId === message.id ? (
                    <form
                      className="message-edit-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveMessageEdit(message.id);
                      }}
                    >
                      <label className="sr-only" htmlFor={`edit-message-${message.id}`}>
                        Edit message
                      </label>
                      <textarea
                        id={`edit-message-${message.id}`}
                        value={editDraft}
                        maxLength={4000}
                        autoFocus
                        disabled={messageActionBusy === message.id}
                        onChange={(event) => setEditDraft(event.target.value)}
                      />
                      <div className="message-action-buttons">
                        <button
                          type="submit"
                          className="quiet-button"
                          disabled={messageActionBusy === message.id || !editDraft.trim()}
                        >
                          {messageActionBusy === message.id ? "Saving..." : "Save"}
                        </button>
                        <button
                          type="button"
                          className="quiet-button"
                          disabled={messageActionBusy === message.id}
                          onClick={() => {
                            setEditingMessageId(null);
                            setEditDraft("");
                            setMessageActionError("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : deleted ? (
                    <div className={`message-bubble deleted-message ${own ? "own" : ""}`}>
                      This message was deleted.
                    </div>
                  ) : message.type === "image" && image ? (
                    <div className={`message-bubble image-message-bubble ${own ? "own" : ""}`}>
                      <PrivateImage
                        path={image.url}
                        alt={message.text || "Shared image"}
                        onOpen={(path, trigger) => {
                          viewerTriggerRef.current = trigger;
                          setViewerMessageId(message.id);
                          setViewerPath(path);
                        }}
                      />
                      {message.text && <p className="image-caption">{message.text}</p>}
                    </div>
                  ) : (
                    <div className={`message-bubble ${own ? "own" : ""}`}>{message.text}</div>
                  )}
                  <time>{formatTime(message.createdAt)}</time>
                  {!deleted && message.editedAt && <span className="message-edited">Edited</span>}
                  {!deleted && message.pinnedAt && (
                    <span className="message-pinned-label" aria-label="Pinned message">Pinned</span>
                  )}
                  {confirmDeleteMessageId === message.id && (
                    <div className="message-delete-confirm" role="group" aria-label="Confirm message unsend">
                      <span>Unsend this message?</span>
                      <button
                        type="button"
                        className="message-action-button"
                        disabled={messageActionBusy === message.id}
                        onClick={() => void confirmDeleteMessage(message.id)}
                      >
                        {messageActionBusy === message.id ? "Unsending..." : "Confirm"}
                      </button>
                      <button
                        type="button"
                        className="message-action-button"
                        disabled={messageActionBusy === message.id}
                        onClick={() => setConfirmDeleteMessageId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {messageActionError && messageActionErrorId === message.id && (
                    <span className="message-action-error" role="alert">{messageActionError}</span>
                  )}
                  {own && !deleted && !isGroup && latestReadOwnMessage?.id === message.id && (
                    <span className="message-receipt" aria-label="Read by recipient">Seen</span>
                  )}
                  {own && !deleted && latestSentOwnMessage?.id === message.id &&
                    (isGroup || latestReadOwnMessage?.id !== message.id) && (
                    <span className="message-receipt" aria-label="Message saved">Sent</span>
                  )}
                  {own && !deleted && isGroup && (
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
                {!own && (
                  <MessageActionToolbar
                    message={message}
                    own={own}
                    deleted={deleted}
                    menuOpen={openMenuMessageId === message.id}
                    busy={messageActionBusy !== null}
                    menuRef={moreMenuRef}
                    onReply={() => startReply(message)}
                    onToggleMenu={(button) => toggleMessageMenu(message.id, button)}
                    onEdit={() => undefined}
                    onUnsend={() => undefined}
                    onPin={() => void togglePin(message)}
                    onForward={() => {
                      setOpenMenuMessageId(null);
                      setForwardMessageId(message.id);
                      setForwardDestinationId(forwardDestinations[0]?.id ?? "");
                      setForwardClientId(window.crypto.randomUUID());
                      setForwardError("");
                    }}
                    onMenuKeyDown={handleMenuKeyDown}
                    hasDestinations={forwardDestinations.length > 0}
                  />
                )}
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
        {replyNavigationError && <p className="reply-navigation-error" role="status">{replyNavigationError}</p>}
        {sendError && <p className="send-error" role="alert">{sendError}</p>}
        {replyToMessageId && replyTarget && (
          <div className="reply-composer-preview">
            <div>
              <span className="reply-composer-label">Replying to {getMessageSenderName(replyTarget)}</span>
              <span className="reply-composer-excerpt">{getReplyExcerpt(replyTarget)}</span>
            </div>
            <button
              type="button"
              className="reply-cancel-button"
              aria-label="Cancel reply"
              onClick={() => {
                setReplyToMessageId(null);
                idempotencyKey.current = null;
                imageIdempotencyKey.current = null;
                setImageRetryAvailable(false);
              }}
              disabled={sending}
            >
              ×
            </button>
          </div>
        )}
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
            ref={composerRef}
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
        </div>
        {conversationInfoOpen && (
          <>
            <div
              className="conversation-info-scrim"
              aria-hidden="true"
              onClick={closeConversationInfo}
            />
            <ConversationInfoPanel
              conversation={conversation}
              groupDetails={groupDetails}
              messages={sharedMediaMessages}
              loading={sharedMediaQuery.isLoading}
              loadingMore={sharedMediaQuery.isFetchingNextPage}
              error={Boolean(sharedMediaQuery.error)}
              navigationError={mediaNavigationError}
              hasMore={Boolean(sharedMediaQuery.hasNextPage)}
              onClose={closeConversationInfo}
              onRetry={() => void sharedMediaQuery.refetch()}
              onLoadMore={() => void sharedMediaQuery.fetchNextPage()}
              onOpenImage={(path, message, trigger) => {
                viewerTriggerRef.current = trigger;
                setViewerMessageId(message.id);
                setViewerPath(path);
              }}
              onNavigateToMessage={(messageId) => void navigateToMessage(messageId)}
            />
          </>
        )}
      </div>
      {forwardMessageId && forwardTarget && (
        <div
          className="forward-dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget && !forwardBusy) setForwardMessageId(null);
          }}
        >
          <section
            ref={forwardDialogRef}
            className="forward-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="forward-message-title"
            tabIndex={-1}
            onKeyDown={handleForwardDialogKeyDown}
          >
            <h2 id="forward-message-title">Forward message</h2>
            <p className="forward-dialog-preview">
              {forwardTarget.deletedAt ? "This message was deleted." : getReplyExcerpt(forwardTarget)}
            </p>
            {forwardDestinations.length ? (
              <>
                <label htmlFor="forward-destination">Choose a conversation</label>
                <select
                  id="forward-destination"
                  value={forwardDestinationId}
                  onChange={(event) => setForwardDestinationId(event.target.value)}
                  disabled={forwardBusy}
                >
                  {forwardDestinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.kind === "group" ? destination.name : destination.otherUser.displayName}
                    </option>
                  ))}
                </select>
                {forwardError && <p className="message-action-error" role="alert">{forwardError}</p>}
                <div className="forward-dialog-actions">
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={forwardBusy}
                    onClick={() => setForwardMessageId(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="send-button"
                    disabled={forwardBusy || !forwardDestinationId}
                    onClick={() => void forwardSelectedMessage()}
                  >
                    {forwardBusy ? "Forwarding..." : "Forward"}
                  </button>
                </div>
              </>
            ) : (
              <p className="muted-note">There are no other conversations to forward to.</p>
            )}
          </section>
        </div>
      )}
      {viewerPath && (
        <div
          className="image-viewer-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setViewerPath(null);
              setViewerMessageId(null);
            }
          }}
        >
          <section className="image-viewer" role="dialog" aria-modal="true" aria-label="Image viewer">
            <button
              ref={viewerCloseRef}
              type="button"
              className="image-viewer-close"
              aria-label="Close image viewer"
              onClick={() => {
                setViewerPath(null);
                setViewerMessageId(null);
              }}
            >
              ×
            </button>
            <PrivateImageViewer path={viewerPath} />
            {viewerMessageId && (
              <button
                type="button"
                className="quiet-button image-viewer-message-link"
                onClick={() => void navigateToMessage(viewerMessageId)}
              >
                View in conversation
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function MessageActionToolbar({
  message,
  own,
  deleted,
  menuOpen,
  busy,
  menuRef,
  onReply,
  onToggleMenu,
  onEdit,
  onUnsend,
  onPin,
  onForward,
  onMenuKeyDown,
  hasDestinations,
}: {
  message: Message;
  own: boolean;
  deleted: boolean;
  menuOpen: boolean;
  busy: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onReply: () => void;
  onToggleMenu: (trigger: HTMLButtonElement) => void;
  onEdit: () => void;
  onUnsend: () => void;
  onPin: () => void;
  onForward: () => void;
  onMenuKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  hasDestinations: boolean;
}) {
  const canForward = message.type === "text" || Boolean(message.image?.url);
  return (
    <div className={`message-action-toolbar ${own ? "own" : "incoming"}`} aria-label="Message actions">
      <button
        type="button"
        className="message-icon-action"
        aria-label={`Reply to ${own ? "your message" : message.sender?.displayName ?? "message"}`}
        title="Reply"
        onClick={onReply}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 8V4L3 11l7 7v-4c5 0 8 1.5 11 5-1-6-4-11-11-11Z" />
        </svg>
      </button>
      {!deleted && (
        <div className="message-more-actions">
          <button
            type="button"
            className="message-icon-action more-actions-trigger"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More actions"
            onClick={(event) => onToggleMenu(event.currentTarget)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="5" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="12" cy="19" r="1.7" />
            </svg>
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="message-action-menu"
              role="menu"
              aria-label="More actions for message"
              onKeyDown={onMenuKeyDown}
            >
              {own && !deleted && message.type === "text" && (
                <button type="button" role="menuitem" disabled={busy} onClick={onEdit}>Edit</button>
              )}
              {own && !deleted && (
                <button type="button" role="menuitem" disabled={busy} onClick={onUnsend}>Unsend</button>
              )}
              {!deleted && (
                <button type="button" role="menuitem" disabled={busy} onClick={onPin}>
                  {message.pinnedAt ? "Unpin" : "Pin"}
                </button>
              )}
              {!deleted && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy || !hasDestinations || !canForward}
                  onClick={onForward}
                >
                  Forward
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatUploadSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}
