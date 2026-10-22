import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { ProfilePhotoDialog } from "../src/auth/ProfilePhotoDialog";
import { authApi, chatApi } from "../src/lib/api";
import type { User } from "../src/types";

vi.mock("../src/lib/api", () => ({
  authApi: {
    me: vi.fn(),
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
    avatarLimits: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
  chatApi: {
    loadPrivateImage: vi.fn(),
  },
}));

const initialUser: User = {
  id: "507f1f77bcf86cd799439011",
  displayName: "Ada Example",
  email: "ada@example.com",
  avatarUrl: null,
};

function CurrentProfileUrl() {
  const { user } = useAuth();
  return <output data-testid="avatar-url">{user?.avatarUrl ?? "none"}</output>;
}

function renderPhotoEditor(onClose = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <CurrentProfileUrl />
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
});

describe("profile photo editor", () => {
  it("previews a selected image and rejects unsupported formats", async () => {
    renderPhotoEditor();
    await screen.findByRole("dialog", { name: "Profile photo" });
    await waitFor(() => expect(document.querySelector(".profile-photo-avatar")).toHaveTextContent("A"));
    const picker = screen.getByLabelText("Choose a profile photo");

    fireEvent.change(picker, {
      target: { files: [new File(["gif"], "avatar.gif", { type: "image/gif" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a JPEG, PNG, or WebP image.");
    expect(screen.getByRole("button", { name: "Save photo" })).toBeDisabled();

    fireEvent.change(picker, {
      target: { files: [new File(["png"], "avatar.png", { type: "image/png" })] },
    });
    expect(screen.getByAltText("Preview of selected profile photo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save photo" })).toBeEnabled();
  });

  it("saves the photo and updates the authenticated user immediately", async () => {
    const updatedUser = { ...initialUser, avatarUrl: "/api/v1/users/507f1f77bcf86cd799439011/avatar?v=1" };
    vi.mocked(authApi.uploadAvatar).mockImplementation(async (_file, onProgress) => {
      onProgress(68);
      return updatedUser;
    });
    renderPhotoEditor();
    await screen.findByRole("dialog", { name: "Profile photo" });
    fireEvent.change(screen.getByLabelText("Choose a profile photo"), {
      target: { files: [new File(["jpeg"], "avatar.jpg", { type: "image/jpeg" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    expect(await screen.findByText("Profile photo updated.")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-url")).toHaveTextContent(updatedUser.avatarUrl);
    expect(authApi.uploadAvatar).toHaveBeenCalledWith(expect.any(File), expect.any(Function));
  });

  it("removes an existing profile photo", async () => {
    const existingUser = { ...initialUser, avatarUrl: "/api/v1/users/507f1f77bcf86cd799439011/avatar?v=1" };
    const removedUser = { ...existingUser, avatarUrl: null };
    vi.mocked(authApi.me).mockResolvedValue(existingUser);
    vi.mocked(authApi.removeAvatar).mockResolvedValue(removedUser);
    renderPhotoEditor();
    await screen.findByRole("button", { name: "Remove photo" });
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));

    expect(await screen.findByText("Profile photo removed.")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-url")).toHaveTextContent("none");
    await waitFor(() => expect(authApi.removeAvatar).toHaveBeenCalledOnce());
  });

  it("keeps the selected photo available for retry after a save error", async () => {
    vi.mocked(authApi.uploadAvatar).mockRejectedValue(new Error("Photo upload failed"));
    renderPhotoEditor();
    await screen.findByRole("dialog", { name: "Profile photo" });
    fireEvent.change(screen.getByLabelText("Choose a profile photo"), {
      target: { files: [new File(["png"], "avatar.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Photo upload failed");
    expect(screen.getByRole("button", { name: "Save photo" })).toBeEnabled();
    expect(screen.getByAltText("Preview of selected profile photo")).toBeInTheDocument();
  });

  it("cancels the editor without changing the account", async () => {
    const onClose = vi.fn();
    renderPhotoEditor(onClose);
    await screen.findByRole("dialog", { name: "Profile photo" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("avatar-url")).toHaveTextContent("none");
  });
});
