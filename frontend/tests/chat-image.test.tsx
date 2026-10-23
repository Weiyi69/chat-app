import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatView } from "../src/chat/ChatView";
import { chatApi } from "../src/lib/api";
import type { Conversation, GroupConversation, Message, MessagePage } from "../src/types";

type ImageSender = (
  file: File,
  caption: string,
  clientId: string,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
  replyToMessageId?: string,
) => Promise<void>;
type ChatTestOptions = {
  conversations?: Conversation[];
  onSend?: (text: string, clientId: string, replyToMessageId?: string) => Promise<void>;
  onPinMessage?: (messageId: string, pinned: boolean) => Promise<void>;
  onForwardMessage?: (messageId: string, destinationConversationId: string, clientId: string) => Promise<void>;
};
const conversation: Conversation = {
  id: "507f1f77bcf86cd799439011",
  otherUser: {
    id: "507f191e810c19729de860ea",
    displayName: "Chat Partner",
    avatarUrl: null,
  },
  latestMessage: null,
};

const groupConversation: GroupConversation = {
  kind: "group",
  id: "507f1f77bcf86cd799439020",
  name: "Weekend plans",
  photoReference: null,
  photoUrl: null,
  currentRole: "member",
  members: [
    {
      userId: "507f191e810c19729de860ea",
      displayName: "Current User",
      avatarUrl: null,
      role: "admin",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      userId: "507f191e810c19729de860eb",
      displayName: "Group Partner",
      avatarUrl: null,
      role: "member",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  latestMessage: null,
};

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:test-image"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  vi.spyOn(chatApi, "receipts").mockResolvedValue([]);
  vi.spyOn(chatApi, "messageReaders").mockResolvedValue([]);
  vi.spyOn(chatApi, "imageLimits").mockResolvedValue({
    maxUploadBytes: 5 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  vi.spyOn(chatApi, "groupPhotoLimits").mockResolvedValue({
    maxUploadBytes: 5 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  });
});

function renderChat(
  onSendImage: ImageSender,
  messages: Message[] = [],
  chatConversation: Conversation = conversation,
  options: ChatTestOptions = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<MessagePage>(["messages", chatConversation.id], { messages, nextCursor: null });
  function ChatHarness() {
    const messagesQuery = useQuery<MessagePage>({
      queryKey: ["messages", chatConversation.id],
      queryFn: async () => ({ messages: [], nextCursor: null }),
      staleTime: Infinity,
    });
    return (
      <ChatView
        conversation={chatConversation}
        conversations={options.conversations ?? [chatConversation, conversation, groupConversation]}
        currentUserId="507f191e810c19729de860ea"
        messagesQuery={messagesQuery}
        socketConnected
        conversationJoined
        socketError=""
        onBack={() => undefined}
        onSend={options.onSend ?? (async () => undefined)}
        onSendImage={onSendImage}
        onMarkRead={async () => undefined}
        onEditMessage={async (messageId, text) => {
          client.setQueryData<MessagePage>(["messages", chatConversation.id], (current) => ({
            messages: (current?.messages ?? []).map((message) =>
              message.id === messageId ? { ...message, text, editedAt: new Date().toISOString() } : message,
            ),
            nextCursor: current?.nextCursor ?? null,
          }));
        }}
        onDeleteMessage={async (messageId) => {
          client.setQueryData<MessagePage>(["messages", chatConversation.id], (current) => ({
            messages: (current?.messages ?? []).map((message) =>
              message.id === messageId
                ? { ...message, text: "This message was deleted.", deletedAt: new Date().toISOString(), image: undefined }
                : message,
            ),
            nextCursor: current?.nextCursor ?? null,
          }));
        }}
        onPinMessage={options.onPinMessage ?? (async () => undefined)}
        onForwardMessage={options.onForwardMessage ?? (async () => undefined)}
      />
    );
  }

  return render(
    <QueryClientProvider client={client}>
      <ChatHarness />
    </QueryClientProvider>,
  );
}

describe("image message composer", () => {
  it("edits and confirms deletion of the current user's text message", async () => {
    const message: Message = {
      id: "507f1f77bcf86cd799439024",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860ea",
      type: "text",
      text: "Original message",
      createdAt: "2026-01-01T12:00:00.000Z",
    };
    renderChat(async () => undefined, [message]);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    fireEvent.change(editor, { target: { value: "Updated message" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(await screen.findByText("Updated message")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsend" }));
    expect(screen.getByRole("group", { name: "Confirm message unsend" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("This message was deleted.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("offers compact actions to incoming messages without exposing owner-only actions", () => {
    const incoming: Message = {
      id: "507f1f77bcf86cd799439025",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860eb",
      type: "text",
      text: "Partner message",
      createdAt: "2026-01-01T12:01:00.000Z",
      sender: { displayName: "Chat Partner", avatarUrl: null },
    };
    renderChat(async () => undefined, [incoming]);

    expect(screen.getByRole("button", { name: "Reply to Chat Partner" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Forward" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Unsend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reaction|emoji/i })).not.toBeInTheDocument();
  });

  it("supports menu keyboard navigation and Escape dismissal", async () => {
    const ownMessage: Message = {
      id: "507f1f77bcf86cd799439026",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860ea",
      type: "text",
      text: "My message",
      createdAt: "2026-01-01T12:02:00.000Z",
    };
    renderChat(async () => undefined, [ownMessage]);
    const trigger = screen.getByRole("button", { name: "More actions" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "More actions for message" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" })));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Forward" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("replies to a selected message and sends its stable message reference", async () => {
    const ownMessage: Message = {
      id: "507f1f77bcf86cd799439027",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860ea",
      type: "text",
      text: "Original text",
      createdAt: "2026-01-01T12:03:00.000Z",
    };
    const onSend = vi.fn(async () => undefined);
    renderChat(async () => undefined, [ownMessage], conversation, { onSend });

    fireEvent.click(screen.getByRole("button", { name: "Reply to your message" }));
    expect(screen.getByText("Replying to You")).toBeInTheDocument();
    expect(screen.getAllByText("Original text")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), {
      target: { value: "A response" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      "A response",
      expect.any(String),
      ownMessage.id,
    ));
    expect(screen.queryByRole("button", { name: "Cancel reply" })).not.toBeInTheDocument();
  });

  it("shows a deleted-original placeholder in replies", () => {
    const deletedOriginal: Message = {
      id: "507f1f77bcf86cd799439028",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860eb",
      type: "text",
      text: "This message was deleted.",
      createdAt: "2026-01-01T12:04:00.000Z",
      deletedAt: "2026-01-01T12:05:00.000Z",
    };
    const reply: Message = {
      id: "507f1f77bcf86cd799439029",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860ea",
      type: "text",
      text: "Understood",
      createdAt: "2026-01-01T12:06:00.000Z",
      reply: {
        id: deletedOriginal.id,
        senderName: "Chat Partner",
        text: "This message was deleted.",
        type: "text",
      },
    };
    renderChat(async () => undefined, [deletedOriginal, reply]);
    expect(screen.getAllByText("This message was deleted.")).toHaveLength(2);
    expect(screen.getByRole("button", {
      name: "Go to reply target from Chat Partner: This message was deleted.",
    })).toBeInTheDocument();
  });

  it("attaches the selected reply target when sending an image", async () => {
    const original: Message = {
      id: "507f1f77bcf86cd799439031",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860eb",
      type: "image",
      text: "",
      createdAt: "2026-01-01T12:08:00.000Z",
      image: {
        contentType: "image/png",
        size: 100,
        width: 2,
        height: 2,
        url: `/api/v1/conversations/${conversation.id}/messages/507f1f77bcf86cd799439031/image`,
      },
      sender: { displayName: "Chat Partner", avatarUrl: null },
    };
    const calls: Parameters<ImageSender>[] = [];
    renderChat(async (...args) => { calls.push(args); }, [original]);
    fireEvent.click(screen.getByRole("button", { name: "Reply to Chat Partner" }));
    expect(screen.getByText("Replying to Chat Partner")).toBeInTheDocument();

    const image = new File(["image bytes"], "reply.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose an image"), { target: { files: [image] } });
    fireEvent.click(screen.getByRole("button", { name: "Send image" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0][5]).toBe(original.id);
  });

  it("pins and forwards through the More actions menu", async () => {
    const ownMessage: Message = {
      id: "507f1f77bcf86cd799439030",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860ea",
      type: "text",
      text: "Share this",
      createdAt: "2026-01-01T12:07:00.000Z",
    };
    const onPinMessage = vi.fn(async () => undefined);
    const onForwardMessage = vi.fn(async () => undefined);
    renderChat(async () => undefined, [ownMessage], conversation, { onPinMessage, onForwardMessage });

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(onPinMessage).toHaveBeenCalledWith(ownMessage.id, true));

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forward" }));
    expect(screen.getByRole("dialog", { name: "Forward message" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(onForwardMessage).toHaveBeenCalledWith(
      ownMessage.id,
      groupConversation.id,
      expect.any(String),
    ));
  });

  it("previews an image and lets the user remove it before sending", () => {
    const calls: Parameters<ImageSender>[] = [];
    const onSendImage: ImageSender = async (...args) => {
      calls.push(args);
    };
    renderChat(onSendImage);
    const image = new File(["image bytes"], "photo.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("Choose an image"), { target: { files: [image] } });

    expect(screen.getByAltText("Selected image preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send image" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
    expect(screen.queryByAltText("Selected image preview")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("sends an image with an optional caption and preserves retry inputs", async () => {
    const calls: Parameters<ImageSender>[] = [];
    const onSendImage: ImageSender = async (...args) => {
      calls.push(args);
    };
    renderChat(onSendImage);
    const image = new File(["image bytes"], "photo.webp", { type: "image/webp" });
    fireEvent.change(screen.getByLabelText("Choose an image"), { target: { files: [image] } });
    fireEvent.change(screen.getByLabelText("Write a message"), { target: { value: "A caption" } });
    fireEvent.click(screen.getByRole("button", { name: "Send image" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0][0]).toBe(image);
    expect(calls[0][1]).toBe("A caption");
    expect(calls[0][2]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(calls[0][4]).toBeInstanceOf(AbortSignal);
    expect(screen.queryByAltText("Selected image preview")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Write a message")).toHaveValue("");
  });

  it("keeps the same idempotency key when retrying a failed image upload", async () => {
    const clientIds: string[] = [];
    let attempt = 0;
    const onSendImage: ImageSender = async (_file, _caption, clientId) => {
      clientIds.push(clientId);
      attempt += 1;
      if (attempt === 1) throw new Error("Upload failed. Try again.");
    };
    renderChat(onSendImage);
    const image = new File(["image bytes"], "retry.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose an image"), { target: { files: [image] } });
    fireEvent.click(screen.getByRole("button", { name: "Send image" }));

    fireEvent.click(await screen.findByRole("button", { name: "Retry image" }));

    await waitFor(() => expect(clientIds).toHaveLength(2));
    expect(clientIds[1]).toBe(clientIds[0]);
    expect(screen.queryByAltText("Selected image preview")).not.toBeInTheDocument();
  });

  it("loads a private image, opens the accessible viewer, and restores focus on close", async () => {
    const message: Message = {
      id: "507f1f77bcf86cd799439012",
      conversationId: conversation.id,
      senderId: conversation.otherUser.id,
      type: "image",
      text: "A caption",
      createdAt: "2026-01-01T12:00:00.000Z",
      image: {
        contentType: "image/png",
        size: 128,
        width: 3,
        height: 2,
        url: `/api/v1/conversations/${conversation.id}/messages/507f1f77bcf86cd799439012/image`,
      },
    };
    vi.spyOn(chatApi, "loadPrivateImage").mockResolvedValue({
      url: "blob:private-image",
      revoke: vi.fn(),
    });
    renderChat(async () => undefined, [message]);

    const openButton = await screen.findByRole("button", { name: "Open image" });
    expect(await screen.findByText("A caption")).toBeInTheDocument();
    fireEvent.click(openButton);

    expect(await screen.findByRole("dialog", { name: "Image viewer" })).toBeInTheDocument();
    expect(await screen.findByAltText("Enlarged shared image")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close image viewer" }));
    await waitFor(() => expect(openButton).toHaveFocus());
  });

  it("shows the group name, sender attribution, and member details", async () => {
    vi.spyOn(chatApi, "groupDetails").mockResolvedValue(groupConversation);
    const message: Message = {
      id: "507f1f77bcf86cd799439021",
      conversationId: groupConversation.id,
      senderId: groupConversation.members[1].userId,
      type: "text",
      text: "See you there",
      createdAt: "2026-01-01T12:00:00.000Z",
      sender: { displayName: "Group Partner", avatarUrl: null },
    };
    renderChat(async () => undefined, [message], groupConversation);

    expect(screen.getByRole("heading", { name: "Weekend plans" })).toBeInTheDocument();
    expect(screen.getByText("Group Partner")).toBeInTheDocument();
    expect(screen.getByText("See you there")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Group details" }));

    expect(await screen.findByRole("dialog", { name: "Group details" })).toBeInTheDocument();
    expect(screen.getByText("Members (2)")).toBeInTheDocument();
    expect(screen.getByText("Current User (you)")).toBeInTheDocument();
    expect(screen.getByText("Group Partner", { selector: ".group-member-name" })).toBeInTheDocument();
  });

  it("shows an accessible direct read label only when the recipient position covers the message", async () => {
    const message: Message = {
      id: "507f1f77bcf86cd799439022",
      conversationId: conversation.id,
      senderId: "507f191e810c19729de860ea",
      type: "text",
      text: "Read this",
      createdAt: "2026-01-01T12:00:00.000Z",
    };
    vi.mocked(chatApi.receipts).mockResolvedValue([{
      userId: "507f191e810c19729de860eb",
      messageId: message.id,
      createdAt: message.createdAt,
      joinedAt: "1970-01-01T00:00:00.000Z",
    }]);
    renderChat(async () => undefined, [message]);

    expect(await screen.findByLabelText("Read by recipient")).toHaveTextContent("Seen");
  });

  it("loads group readers only after the Seen by control is opened", async () => {
    const message: Message = {
      id: "507f1f77bcf86cd799439023",
      conversationId: groupConversation.id,
      senderId: groupConversation.members[0].userId,
      type: "text",
      text: "Plan confirmed",
      createdAt: "2026-01-01T12:00:00.000Z",
    };
    vi.mocked(chatApi.messageReaders).mockResolvedValue([{
      userId: groupConversation.members[1].userId,
      displayName: "Group Partner",
    }]);
    renderChat(async () => undefined, [message], groupConversation);

    expect(screen.queryByText("Seen by Group Partner")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Seen by" }));

    expect(await screen.findByText("Seen by Group Partner")).toBeInTheDocument();
    expect(chatApi.messageReaders).toHaveBeenCalledWith(groupConversation.id, message.id);
  });

  it("previews, cancels, saves, and removes an administrator's group photo", async () => {
    const adminGroup: GroupConversation = { ...groupConversation, currentRole: "admin" };
    const photoUrl = `/api/v1/conversations/groups/${adminGroup.id}/photo?v=first.webp`;
    const uploadedGroup: GroupConversation = {
      ...adminGroup,
      photoReference: "first.webp",
      photoUrl,
    };
    const removedGroup: GroupConversation = {
      ...adminGroup,
      photoReference: null,
      photoUrl: null,
    };
    vi.spyOn(chatApi, "groupDetails").mockResolvedValue(adminGroup);
    vi.spyOn(chatApi, "loadPrivateImage").mockResolvedValue({
      url: "blob:group-photo",
      revoke: vi.fn(),
    });
    const upload = vi.spyOn(chatApi, "uploadGroupPhoto").mockResolvedValue(uploadedGroup);
    const remove = vi.spyOn(chatApi, "removeGroupPhoto").mockResolvedValue(removedGroup);
    renderChat(async () => undefined, [], adminGroup);

    fireEvent.click(screen.getByRole("button", { name: "Group details" }));
    const input = await screen.findByLabelText("Choose a group photo");
    const photo = new File(["photo bytes"], "group.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [photo] } });
    expect(screen.getByAltText("Preview of selected group photo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByAltText("Preview of selected group photo")).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [photo] } });
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(adminGroup.id, photo, expect.any(Function)));
    expect(await screen.findByRole("status")).toHaveTextContent("Group photo updated.");
    expect(await screen.findByRole("button", { name: "Remove photo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(adminGroup.id));
    expect(await screen.findByRole("status")).toHaveTextContent("Group photo removed.");
    expect(screen.queryByAltText("Preview of selected group photo")).not.toBeInTheDocument();
  });

  it("uses the default group icon when a stored photo cannot be loaded", async () => {
    const groupWithMissingPhoto: GroupConversation = {
      ...groupConversation,
      photoReference: "missing.webp",
      photoUrl: `/api/v1/conversations/groups/${groupConversation.id}/photo?v=missing.webp`,
    };
    vi.spyOn(chatApi, "groupDetails").mockResolvedValue(groupWithMissingPhoto);
    vi.spyOn(chatApi, "loadPrivateImage").mockRejectedValue(new Error("Photo not found"));
    renderChat(async () => undefined, [], groupWithMissingPhoto);

    expect(await screen.findAllByText("Weekend plans")).toHaveLength(1);
    await waitFor(() => expect(document.querySelector(".group-avatar svg")).toBeInTheDocument());
  });
});
