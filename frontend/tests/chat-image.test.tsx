import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatView } from "../src/chat/ChatView";
import { chatApi } from "../src/lib/api";
import type { Conversation, Message, MessagePage } from "../src/types";

type ImageSender = (
  file: File,
  caption: string,
  clientId: string,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
) => Promise<void>;
const conversation: Conversation = {
  id: "507f1f77bcf86cd799439011",
  otherUser: {
    id: "507f191e810c19729de860ea",
    displayName: "Chat Partner",
    avatarUrl: null,
  },
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
  vi.spyOn(chatApi, "imageLimits").mockResolvedValue({
    maxUploadBytes: 5 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  });
});

function renderChat(onSendImage: ImageSender, messages: Message[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<MessagePage>(["messages", conversation.id], { messages, nextCursor: null });
  function ChatHarness() {
    const messagesQuery = useQuery<MessagePage>({
      queryKey: ["messages", conversation.id],
      queryFn: async () => ({ messages: [], nextCursor: null }),
      staleTime: Infinity,
    });
    return (
      <ChatView
        conversation={conversation}
        currentUserId="507f191e810c19729de860ea"
        messagesQuery={messagesQuery}
        socketConnected
        socketError=""
        onBack={() => undefined}
        onSend={async () => undefined}
        onSendImage={onSendImage}
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
});
