import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { useAuth } from "../auth/AuthProvider";
import { chatApi, socketUrl } from "../lib/api";
import type { Conversation, Message, MessagePage } from "../types";
import { ChatView } from "./ChatView";
import { ConversationSidebar } from "./ConversationSidebar";
import { mergeMessages } from "./chat-utils";

function mergeMessageIntoPage(current: MessagePage | undefined, message: Message): MessagePage {
  const updatedReplies = (current?.messages ?? []).map((candidate) => {
    if (candidate.reply?.id !== message.id) return candidate;
    return {
      ...candidate,
      reply: {
        id: message.id,
        senderName: message.sender?.displayName ?? candidate.reply.senderName,
        text: message.deletedAt
          ? "This message was deleted."
          : message.type === "image"
            ? (message.text || "Photo")
            : message.text,
        type: message.type,
      },
    };
  });
  return {
    messages: mergeMessages(updatedReplies, [message]),
    nextCursor: current?.nextCursor ?? null,
  };
}

function updateConversationPreview(current: Conversation[] | undefined, message: Message) {
  if (!current) return current;
  return current
    .map((conversation) => {
      if (conversation.id !== message.conversationId) return conversation;
      const latestAt = conversation.latestMessage?.createdAt;
      if (latestAt && new Date(message.createdAt).getTime() < new Date(latestAt).getTime()) {
        return conversation;
      }
      return {
        ...conversation,
        latestMessage: {
          text: (message.text || "[Image]").slice(0, 200),
          createdAt: message.createdAt,
        },
      };
    })
    .sort(
      (first, second) =>
        new Date(second.latestMessage?.createdAt ?? 0).getTime() -
        new Date(first.latestMessage?.createdAt ?? 0).getTime(),
    );
}

export function ChatWorkspace() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [joinedConversationId, setJoinedConversationId] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketError, setSocketError] = useState("");
  const socket = useMemo<Socket>(() => io(socketUrl, { autoConnect: false, withCredentials: true }), []);

  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: chatApi.conversations,
  });
  const activeConversation = conversationsQuery.data?.find((item) => item.id === activeId) ?? null;
  const messagesQuery = useQuery({
    queryKey: ["messages", activeId],
    queryFn: () => chatApi.messages(activeId!),
    enabled: Boolean(activeId),
  });

  useEffect(() => {
    const onConnect = () => {
      setSocketConnected(true);
      setSocketError("");
      void queryClient.invalidateQueries({ queryKey: ["receipts"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    };
    const onDisconnect = () => setSocketConnected(false);
    const onConnectError = () => {
      setSocketConnected(false);
      setSocketError("Reconnecting to live messages...");
    };
    const onMessage = (message: Message) => {
      queryClient.setQueryData<MessagePage>(["messages", message.conversationId], (current) =>
        mergeMessageIntoPage(current, message),
      );
      queryClient.setQueryData<Conversation[]>(["conversations"], (current) =>
        updateConversationPreview(current, message),
      );
    };
    const onMessageUpdated = (message: Message) => {
      queryClient.setQueryData<MessagePage>(["messages", message.conversationId], (current) =>
        mergeMessageIntoPage(current, message),
      );
      queryClient.setQueryData<Conversation[]>(["conversations"], (current) =>
        updateConversationPreview(current, message),
      );
    };
    const onGroupUpdated = ({ conversationId }: { conversationId: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["group", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["receipts", conversationId] });
    };
    const onReceiptUpdated = ({ conversationId }: { conversationId: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["receipts", conversationId] });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("message:new", onMessage);
    socket.on("message:updated", onMessageUpdated);
    socket.on("group:updated", onGroupUpdated);
    socket.on("receipt:updated", onReceiptUpdated);
    socket.connect();
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("message:new", onMessage);
      socket.off("message:updated", onMessageUpdated);
      socket.off("group:updated", onGroupUpdated);
      socket.off("receipt:updated", onReceiptUpdated);
      socket.disconnect();
    };
  }, [queryClient, socket]);

  useEffect(() => {
    setJoinedConversationId(null);
    if (!activeId || !socketConnected) return;
    socket.emit(
      "conversation:join",
      { conversationId: activeId },
      (result: { ok: boolean; error?: { message: string } }) => {
        if (!result.ok) {
          setJoinedConversationId(null);
          setSocketError(result.error?.message ?? "Could not open this conversation");
        } else {
          setJoinedConversationId(activeId);
          setSocketError("");
          void queryClient.invalidateQueries({ queryKey: ["receipts", activeId] });
        }
      },
    );
  }, [activeId, queryClient, socket, socketConnected]);

  useEffect(() => {
    if (activeId && conversationsQuery.data?.some((item) => item.id === activeId)) return;
    if (activeId && !conversationsQuery.isLoading) setActiveId(null);
  }, [activeId, conversationsQuery.data, conversationsQuery.isLoading]);

  async function sendMessage(text: string, clientId: string, replyToMessageId?: string) {
    if (!activeConversation) return;
    const message = await chatApi.sendMessage(activeConversation.id, text, clientId, replyToMessageId);
    queryClient.setQueryData<MessagePage>(["messages", activeConversation.id], (current) =>
      mergeMessageIntoPage(current, message),
    );
    queryClient.setQueryData<Conversation[]>(["conversations"], (current) =>
      updateConversationPreview(current, message),
    );
  }

  async function sendImage(
    file: File,
    caption: string,
    clientId: string,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    replyToMessageId?: string,
  ) {
    if (!activeConversation) return;
    const message = await chatApi.sendImage(
      activeConversation.id,
      file,
      caption,
      clientId,
      onProgress,
      signal,
      replyToMessageId,
    );
    queryClient.setQueryData<MessagePage>(["messages", activeConversation.id], (current) =>
      mergeMessageIntoPage(current, message),
    );
    queryClient.setQueryData<Conversation[]>(["conversations"], (current) =>
      updateConversationPreview(current, message),
    );
  }

  function markRead(conversationId: string, messageId: string) {
    return new Promise<void>((resolve, reject) => {
      socket.timeout(5000).emit(
        "conversation:read",
        { conversationId, messageId },
        (error: Error | null, result: { ok: boolean; error?: { message: string } }) => {
          if (error) {
            reject(new Error("Read status could not be synchronized"));
          } else if (!result.ok) {
            reject(new Error(result.error?.message ?? "Read status could not be synchronized"));
          } else {
            resolve();
          }
        },
      );
    });
  }

  async function editMessage(
    conversationId: string,
    messageId: string,
    text: string,
    revision: number,
  ) {
    const message = await chatApi.editMessage(conversationId, messageId, text, revision);
    onMessageUpdatedInCache(message);
    return message;
  }

  async function deleteMessage(conversationId: string, messageId: string, revision: number) {
    const message = await chatApi.deleteMessage(conversationId, messageId, revision);
    onMessageUpdatedInCache(message);
    return message;
  }

  async function setMessagePinned(messageId: string, pinned: boolean) {
    if (!activeConversation) return;
    const message = await chatApi.setMessagePinned(activeConversation.id, messageId, pinned);
    onMessageUpdatedInCache(message);
  }

  async function forwardMessage(
    messageId: string,
    destinationConversationId: string,
    clientId: string,
  ) {
    if (!activeConversation) return;
    const message = await chatApi.forwardMessage(
      activeConversation.id,
      messageId,
      destinationConversationId,
      clientId,
    );
    onMessageUpdatedInCache(message);
  }

  function onMessageUpdatedInCache(message: Message) {
    queryClient.setQueryData<MessagePage>(["messages", message.conversationId], (current) =>
      mergeMessageIntoPage(current, message),
    );
    queryClient.setQueryData<Conversation[]>(["conversations"], (current) =>
      updateConversationPreview(current, message),
    );
  }

  return (
    <main className={`workspace ${activeId ? "has-active-chat" : ""}`}>
      <ConversationSidebar
        activeId={activeId}
        socketConnected={socketConnected}
        onSelect={setActiveId}
      />
      <section className="chat-panel" aria-label="Active conversation">
        {activeConversation ? (
          <ChatView
            conversation={activeConversation}
            conversations={conversationsQuery.data ?? []}
            currentUserId={user?.id ?? ""}
            messagesQuery={messagesQuery}
            socketConnected={socketConnected}
            conversationJoined={joinedConversationId === activeId}
            socketError={socketError}
            onBack={() => setActiveId(null)}
            onSend={sendMessage}
            onSendImage={sendImage}
            onMarkRead={(messageId) => markRead(activeConversation.id, messageId)}
            onEditMessage={(messageId, text, revision) =>
              editMessage(activeConversation.id, messageId, text, revision)}
            onDeleteMessage={(messageId, revision) =>
              deleteMessage(activeConversation.id, messageId, revision)}
            onPinMessage={setMessagePinned}
            onForwardMessage={forwardMessage}
          />
        ) : (
          <div className="welcome-panel">
            <div className="welcome-illustration" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className="eyebrow">A LITTLE MORE PERSONAL</p>
            <h2>Your next good conversation starts here.</h2>
            <p>Choose a conversation or find someone new to say hello.</p>
          </div>
        )}
      </section>
    </main>
  );
}
