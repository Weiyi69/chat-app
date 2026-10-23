import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

function renderAuthRoutes(initialEntry = "/register") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
          </Routes>
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
      bio: "",
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

describe("login form", () => {
  beforeEach(() => vi.clearAllMocks());

  it("submits valid login details", async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      id: "abc123",
      displayName: "Ada Lovelace",
      bio: "",
      email: "ada@example.com",
      avatarUrl: null,
    });
    renderAuthPage("login");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(authApi.login).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "correct-horse-battery",
      }),
    );
  });

  it("navigates between registration and login pages", async () => {
    renderAuthRoutes();
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Create an account" }));
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeInTheDocument();
  });
});

describe("authentication branding", () => {
  it.each(["login", "register"] as const)("omits the Converse logo on the %s page", (mode) => {
    renderAuthPage(mode);

    expect(screen.queryByRole("img", { name: "Converse logo" })).not.toBeInTheDocument();
  });
});
