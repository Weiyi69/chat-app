import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { ProfilePhotoDialog } from "../src/auth/ProfilePhotoDialog";
import { ConversationSidebar } from "../src/chat/ConversationSidebar";
import { authApi, chatApi } from "../src/lib/api";
import type { User } from "../src/types";

vi.mock("../src/lib/api", () => ({
  authApi: {
    me: vi.fn(),
    updateProfile: vi.fn(),
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
    avatarLimits: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
  chatApi: {
    loadPrivateImage: vi.fn(),
    conversations: vi.fn(),
    searchUsers: vi.fn(),
    createConversation: vi.fn(),
    createGroup: vi.fn(),
  },
}));

const initialUser: User = {
  id: "507f1f77bcf86cd799439011",
  displayName: "Ada Example",
  bio: "",
  email: "ada@example.com",
  avatarUrl: null,
};

function CurrentProfile() {
  const { user } = useAuth();
  return (
    <>
      <output data-testid="profile-name">{user?.displayName ?? "none"}</output>
      <output data-testid="profile-bio">{user?.bio ?? "none"}</output>
      <output data-testid="profile-email">{user?.email ?? "none"}</output>
      <output data-testid="avatar-url">{user?.avatarUrl ?? "none"}</output>
    </>
  );
}

function renderProfileEditor(onClose = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <CurrentProfile />
        <ProfilePhotoDialog onClose={onClose} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:avatar-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authApi.me).mockResolvedValue(initialUser);
  vi.mocked(authApi.avatarLimits).mockResolvedValue({
    maxUploadBytes: 5 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  vi.mocked(chatApi.loadPrivateImage).mockResolvedValue({
    url: "blob:private-avatar",
    revoke: vi.fn(),
  });
  vi.mocked(chatApi.conversations).mockResolvedValue([]);
  vi.mocked(chatApi.searchUsers).mockResolvedValue({ users: [], nextCursor: null });
});

describe("profile editor", () => {
  it("previews a selected image and rejects unsupported formats and oversized files", async () => {
    renderProfileEditor();
    await screen.findByRole("dialog", { name: "Edit profile" });
    await waitFor(() => expect(screen.getByLabelText("Display name")).toHaveValue("Ada Example"));
    expect(screen.getByLabelText("Bio")).toHaveValue("");
    const picker = screen.getByLabelText("Choose a profile photo");

    fireEvent.change(picker, {
      target: { files: [new File(["gif"], "avatar.gif", { type: "image/gif" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a JPEG, PNG, or WebP image.");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.change(picker, {
      target: { files: [new File(["x".repeat(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an image smaller than 5 MB.");

    fireEvent.change(picker, {
      target: { files: [new File(["png"], "avatar.png", { type: "image/png" })] },
    });
    expect(screen.getByAltText("Preview of selected profile photo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("saves the trimmed display name and bio and updates the authenticated profile", async () => {
    const updatedUser = { ...initialUser, displayName: "Ada Lovelace", bio: "Mathematician" };
    vi.mocked(authApi.updateProfile).mockImplementation(async (_profile, onProgress) => {
      onProgress(100);
      return updatedUser;
    });
    renderProfileEditor();
    await screen.findByRole("dialog", { name: "Edit profile" });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  Ada Lovelace  " } });
    fireEvent.change(screen.getByLabelText("Bio"), { target: { value: "Mathematician" } });
    expect(screen.getByText("13/160")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Profile changes saved.")).toBeInTheDocument();
    expect(screen.getByTestId("profile-name")).toHaveTextContent("Ada Lovelace");
    expect(screen.getByTestId("profile-bio")).toHaveTextContent("Mathematician");
    expect(screen.getByTestId("profile-email")).toHaveTextContent("ada@example.com");
    expect(authApi.updateProfile).toHaveBeenCalledWith(
      { displayName: "Ada Lovelace", bio: "Mathematician", avatar: null, removeAvatar: false },
      expect.any(Function),
    );
  });

  it("reflects a saved display name in the profile dropdown", async () => {
    vi.mocked(authApi.updateProfile).mockResolvedValue({
      ...initialUser,
      displayName: "Ada Lovelace",
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <ConversationSidebar activeId={null} socketConnected onSelect={vi.fn()} />
        </AuthProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByLabelText("Account menu for Ada Example"));
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    await screen.findByRole("dialog", { name: "Edit profile" });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByLabelText("Account menu for Ada Lovelace")).toBeInTheDocument());
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("allows a bio to be cleared and enforces frontend name and bio limits", async () => {
    const existingUser = { ...initialUser, bio: "Current bio" };
    vi.mocked(authApi.me).mockResolvedValue(existingUser);
    vi.mocked(authApi.updateProfile).mockResolvedValue({ ...existingUser, bio: "" });
    renderProfileEditor();
    await screen.findByRole("dialog", { name: "Edit profile" });
    const name = screen.getByLabelText("Display name");
    const bio = screen.getByLabelText("Bio");

    fireEvent.change(name, { target: { value: "   " } });
    expect(screen.getByText("Enter a display name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "x".repeat(65) } });
    expect(screen.getByText("Display name must be 64 characters or fewer.")).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "Ada Example" } });

    fireEvent.change(bio, { target: { value: "b".repeat(160) } });
    expect(screen.getByText("160/160")).toBeInTheDocument();
    fireEvent.change(bio, { target: { value: "b".repeat(161) } });
    expect(screen.getByText("Bio must be 160 characters or fewer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(bio, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Profile changes saved.")).toBeInTheDocument();
    expect(authApi.updateProfile).toHaveBeenCalledWith(
      { displayName: "Ada Example", bio: "", avatar: null, removeAvatar: false },
      expect.any(Function),
    );
  });

  it("prevents duplicate saves and retains edits after a save failure", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    vi.mocked(authApi.updateProfile).mockImplementation(
      () => new Promise((_resolve, reject) => { rejectSave = reject; }),
    );
    renderProfileEditor();
    await screen.findByRole("dialog", { name: "Edit profile" });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Updated" } });
    const save = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(save).toHaveTextContent("Saving..."));
    expect(authApi.updateProfile).toHaveBeenCalledOnce();
    rejectSave?.(new Error("Profile save failed"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Profile save failed");
    expect(screen.getByLabelText("Display name")).toHaveValue("Ada Updated");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByTestId("profile-name")).toHaveTextContent("Ada Example");
  });

  it("stages photo removal and discards all pending edits when cancelled", async () => {
    const onClose = vi.fn();
    const existingUser = {
      ...initialUser,
      avatarUrl: "/api/v1/users/507f1f77bcf86cd799439011/avatar?v=1",
    };
    vi.mocked(authApi.me).mockResolvedValue(existingUser);
    renderProfileEditor(onClose);
    await screen.findByRole("button", { name: "Remove photo" });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));

    expect(screen.getByRole("button", { name: "Undo remove photo" })).toBeInTheDocument();
    expect(authApi.updateProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("profile-name")).toHaveTextContent("Ada Example");
    expect(screen.getByTestId("avatar-url")).toHaveTextContent(existingUser.avatarUrl);
    expect(authApi.updateProfile).not.toHaveBeenCalled();
  });

  it("saves staged photo removal together with text changes", async () => {
    const existingUser = {
      ...initialUser,
      avatarUrl: "/api/v1/users/507f1f77bcf86cd799439011/avatar?v=1",
    };
    vi.mocked(authApi.me).mockResolvedValue(existingUser);
    vi.mocked(authApi.updateProfile).mockResolvedValue({
      ...existingUser,
      displayName: "Ada Updated",
      avatarUrl: null,
    });
    renderProfileEditor();
    await screen.findByRole("button", { name: "Remove photo" });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Profile changes saved.")).toBeInTheDocument();
    expect(authApi.updateProfile).toHaveBeenCalledWith(
      { displayName: "Ada Updated", bio: "", avatar: null, removeAvatar: true },
      expect.any(Function),
    );
    expect(screen.getByTestId("profile-name")).toHaveTextContent("Ada Updated");
    expect(screen.getByTestId("avatar-url")).toHaveTextContent("none");
  });
});
