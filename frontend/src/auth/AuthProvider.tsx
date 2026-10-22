import { createContext, useContext, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { authApi } from "../lib/api";
import type { User } from "../types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  initializationError: Error | null;
  retryInitialization: () => void;
  login: (data: { email: string; password: string }) => Promise<void>;
  register: (data: { displayName: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateAvatar: (file: File, onProgress: (progress: number) => void) => Promise<void>;
  removeAvatar: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const userQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        return await authApi.me();
      } catch (error) {
        if (error instanceof Error && "status" in error && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user: userQuery.data ?? null,
      loading: userQuery.isLoading,
      initializationError: userQuery.error instanceof Error ? userQuery.error : null,
      retryInitialization: () => {
        void userQuery.refetch();
      },
      login: async (data) => {
        queryClient.setQueryData(["auth", "me"], await authApi.login(data));
      },
      register: async (data) => {
        queryClient.setQueryData(["auth", "me"], await authApi.register(data));
      },
      logout: async () => {
        await authApi.logout();
        queryClient.setQueryData(["auth", "me"], null);
        queryClient.removeQueries({ queryKey: ["conversations"] });
        queryClient.removeQueries({ queryKey: ["messages"] });
      },
      updateAvatar: async (file, onProgress) => {
        const updatedUser = await authApi.uploadAvatar(file, onProgress);
        queryClient.setQueryData(["auth", "me"], updatedUser);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["conversations"] }),
          queryClient.invalidateQueries({ queryKey: ["user-search"] }),
        ]);
      },
      removeAvatar: async () => {
        const updatedUser = await authApi.removeAvatar();
        queryClient.setQueryData(["auth", "me"], updatedUser);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["conversations"] }),
          queryClient.invalidateQueries({ queryKey: ["user-search"] }),
        ]);
      },
    }),
    [queryClient, userQuery.data, userQuery.error, userQuery.isLoading, userQuery.refetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
