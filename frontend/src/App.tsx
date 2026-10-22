import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useMemo } from "react";

import { AuthPage } from "./auth/AuthPage";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ChatWorkspace } from "./chat/ChatWorkspace";
import "./styles.css";

function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <main className="loading-page"><span className="loading-spinner" />Loading your space...</main>;
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <ChatWorkspace />;
}

function AppRoutes() {
  const { loading, user, initializationError, retryInitialization } = useAuth();
  if (loading) {
    return <main className="loading-page"><span className="loading-spinner" />Loading your space...</main>;
  }
  if (initializationError && !user) {
    return (
      <main className="loading-page auth-load-error">
        <div>
          <p>Converse could not reach the server.</p>
          <button className="quiet-button" type="button" onClick={retryInitialization}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <AuthPage mode="login" />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <AuthPage mode="register" />} />
      <Route path="/" element={<ProtectedRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false },
        },
      }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
