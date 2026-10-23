import request from "supertest";
import { describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { loginSchema, profileUpdateSchema, registerSchema } from "../src/validators/auth.js";

describe("authentication boundary", () => {
  it("normalizes email addresses and rejects weak registration passwords", () => {
    expect(
      registerSchema.parse({
        displayName: "  Ada  ",
        email: "ADA@example.com",
        password: "a-secure-password",
      }),
    ).toEqual({
      displayName: "Ada",
      email: "ada@example.com",
      password: "a-secure-password",
    });

    expect(() =>
      registerSchema.parse({
        displayName: "Ada",
        email: "ada@example.com",
        password: "short",
      }),
    ).toThrow();
  });

  it("requires CSRF tokens for state-changing requests", async () => {
    const agent = request.agent(app);
    const csrfResponse = await agent.get("/api/v1/auth/csrf");
    const token = csrfResponse.body.token as string;

    expect(csrfResponse.status).toBe(200);
    expect(token).toBeTruthy();
    await agent.post("/api/v1/auth/logout").expect(403);
    await agent.post("/api/v1/auth/logout").set("x-csrf-token", token).expect(204);
  });

  it("returns a non-sensitive health response", async () => {
    await request(app).get("/api/v1/health").expect(200, { status: "ok" });
  });

  it("validates email format on login", () => {
    expect(() => loginSchema.parse({ email: "not-an-email", password: "something" })).toThrow();
  });

  it("validates profile names, optional bios, and rejects client-supplied identity", () => {
    expect(profileUpdateSchema.parse({
      displayName: "  Ada  ",
      bio: "",
    })).toEqual({ displayName: "Ada", bio: "" });
    expect(() => profileUpdateSchema.parse({ displayName: "   ", bio: "" })).toThrow();
    expect(() => profileUpdateSchema.parse({ displayName: "x".repeat(65), bio: "" })).toThrow();
    expect(() => profileUpdateSchema.parse({ displayName: "Ada", bio: "b".repeat(161) })).toThrow();
    expect(() =>
      profileUpdateSchema.parse({ displayName: "Ada", bio: "", userId: "another-user" }),
    ).toThrow();
  });

  it("requires both CSRF protection and an authenticated session for profile updates", async () => {
    const agent = request.agent(app);
    const csrfResponse = await agent.get("/api/v1/auth/csrf");
    const token = csrfResponse.body.token as string;

    await agent
      .put("/api/v1/auth/me/profile")
      .field("displayName", "Ada")
      .field("bio", "")
      .expect(403);
    await agent
      .put("/api/v1/auth/me/profile")
      .set("x-csrf-token", token)
      .field("displayName", "Ada")
      .field("bio", "")
      .expect(401);
  });
});
