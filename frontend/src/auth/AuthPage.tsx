import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link, Navigate, useLocation } from "react-router-dom";
import { z } from "zod";
import { useState } from "react";

import { useAuth } from "./AuthProvider";

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  displayName: z.string().trim().min(1, "Enter your name").max(64),
  email: z.email("Enter a valid email address"),
  password: z.string().min(12, "Use at least 12 characters").max(128),
});

type LoginValues = z.infer<typeof loginSchema>;
type RegisterValues = z.infer<typeof registerSchema>;

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { user, login, register } = useAuth();
  const location = useLocation();
  const [error, setError] = useState("");
  const isRegister = mode === "register";

  const loginForm = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });
  const registerForm = useForm<RegisterValues>({ resolver: zodResolver(registerSchema) });
  const busy = isRegister ? registerForm.formState.isSubmitting : loginForm.formState.isSubmitting;

  if (user) return <Navigate to="/" replace />;

  async function submitLogin(values: LoginValues) {
    setError("");
    try {
      await login(values);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in");
    }
  }

  async function submitRegister(values: RegisterValues) {
    setError("");
    try {
      await register(values);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create your account");
    }
  }

  const destination = (location.state as { from?: string } | null)?.from ?? "/";

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-heading">
        <img className="brand-mark logo-image" src="/converse-logo.png" alt="Converse logo" />
        <p className="eyebrow">PRIVATE MESSAGES, MADE SIMPLE</p>
        <h1 id="auth-heading">{isRegister ? "Create your account" : "Welcome back"}</h1>
        <p className="auth-subtitle">
          {isRegister ? "Start a conversation with someone you know." : "Sign in to pick up where you left off."}
        </p>

        {isRegister ? (
          <form onSubmit={registerForm.handleSubmit(submitRegister)} noValidate>
            <label htmlFor="displayName">Display name</label>
            <input id="displayName" autoComplete="name" {...registerForm.register("displayName")} />
            {registerForm.formState.errors.displayName && (
              <span className="field-error">{registerForm.formState.errors.displayName.message}</span>
            )}
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" {...registerForm.register("email")} />
            {registerForm.formState.errors.email && (
              <span className="field-error">{registerForm.formState.errors.email.message}</span>
            )}
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              {...registerForm.register("password")}
            />
            {registerForm.formState.errors.password && (
              <span className="field-error">{registerForm.formState.errors.password.message}</span>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button auth-submit" disabled={busy}>
              {busy ? "Creating account..." : "Create account"}
            </button>
          </form>
        ) : (
          <form onSubmit={loginForm.handleSubmit(submitLogin)} noValidate>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" {...loginForm.register("email")} />
            {loginForm.formState.errors.email && (
              <span className="field-error">Enter a valid email address</span>
            )}
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" {...loginForm.register("password")} />
            {loginForm.formState.errors.password && (
              <span className="field-error">Enter your password</span>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button auth-submit" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}
        <p className="auth-switch">
          {isRegister ? "Already have an account?" : "New to Converse?"}{" "}
          <Link to={isRegister ? "/login" : "/register"} replace state={{ from: destination }}>
            {isRegister ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
    </main>
  );
}
