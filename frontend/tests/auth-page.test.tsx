import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthPage } from "../src/auth/AuthPage";
import { AuthProvider } from "../src/auth/AuthProvider";
import { authApi } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  authApi: {
    me: vi.fn().mockResolvedValue(null),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
}));

function renderAuthPage(mode: "login" | "register" = "register") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter>
          <AuthPage mode={mode} />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("registration form", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a strong password before submitting", async () => {
    renderAuthPage();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Use at least 12 characters")).toBeInTheDocument();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it("submits valid registration details", async () => {
    vi.mocked(authApi.register).mockResolvedValue({
      id: "abc123",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
    });
    renderAuthPage();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a-long-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(authApi.register).toHaveBeenCalledWith({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      password: "a-long-secure-password",
    }));
  });
});

describe("authentication branding", () => {
  it.each(["login", "register"] as const)("shows the Converse logo on the %s page", (mode) => {
    renderAuthPage(mode);

    expect(screen.getByRole("img", { name: "Converse logo" })).toHaveAttribute(
      "src",
      "/converse-logo.png",
    );
  });
});
