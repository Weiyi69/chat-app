import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, unlink, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import sharp from "sharp";
import type { Server as SocketServer } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../src/app.js";
import { avatarStorageRoot, env, imageStorageRoot } from "../src/config/env.js";
import { sessionStore } from "../src/config/session.js";
import { Conversation } from "../src/models/conversation.js";
import { Message } from "../src/models/message.js";
import { User } from "../src/models/user.js";
import * as avatarService from "../src/services/avatars.js";
import { cleanupOrphanedImages } from "../src/services/image-messages.js";
import { imageStorage } from "../src/services/image-storage.js";
import { attachSocketServer } from "../src/sockets/realtime.js";

const clientOrigin = "http://localhost:5173";

interface RegisteredAccount {
  agent: ReturnType<typeof request.agent>;
  userId: string;
  cookie: string;
  csrfToken: string;
}

let mongo: MongoMemoryServer | undefined;
let server: HttpServer | undefined;
let socketServer: SocketServer | undefined;
let baseUrl: string;
let sharedAccounts: { alice: RegisteredAccount; bob: RegisteredAccount; eve: RegisteredAccount } | undefined;

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }): string {
  const cookies = response.headers["set-cookie"];
  if (!cookies) throw new Error("Expected authentication cookie");
  return (Array.isArray(cookies) ? cookies : [cookies])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function registerAccount(displayName: string, email: string): Promise<RegisteredAccount> {
  const agent = request.agent(baseUrl);
  const csrf = await agent.get("/api/v1/auth/csrf").expect(200);
  const response = await agent
    .post("/api/v1/auth/register")
    .set("x-csrf-token", csrf.body.token as string)
    .send({ displayName, email, password: "a-secure-test-password" })
    .expect(201);
  const currentCsrf = await agent.get("/api/v1/auth/csrf").expect(200);

  return {
    agent,
    userId: response.body.user.id as string,
    cookie: cookieHeader(response),
    csrfToken: currentCsrf.body.token as string,
  };
}

async function createFixtureAccount(displayName: string, email: string): Promise<RegisteredAccount> {
  const user = await User.create({
    displayName,
    displayNameSearch: displayName.toLowerCase(),
    email,
    passwordHash: "fixture-account-password-hash",
  });
  const agent = request.agent(baseUrl);
  const csrfResponse = await agent.get("/api/v1/auth/csrf").expect(200);
  const cookie = cookieHeader(csrfResponse);
  const encodedSession = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const sessionId = encodedSession.slice(2, encodedSession.lastIndexOf("."));
  await new Promise<void>((resolve, reject) => {
    sessionStore.get(sessionId, (error, session) => {
      if (error) {
        reject(error);
        return;
      }
      if (!session) {
        reject(new Error("Expected the test session to be stored"));
        return;
      }
      session.userId = user._id.toString();
      sessionStore.set(sessionId, session, (saveError) => saveError ? reject(saveError) : resolve());
    });
  });
  const csrf = await agent.get("/api/v1/auth/csrf").expect(200);
  return {
    agent,
    userId: user._id.toString(),
    cookie,
    csrfToken: csrf.body.token as string,
  };
}

async function loginAccount(email: string): Promise<RegisteredAccount> {
  const agent = request.agent(baseUrl);
  const csrf = await agent.get("/api/v1/auth/csrf").expect(200);
  const response = await agent
    .post("/api/v1/auth/login")
    .set("x-csrf-token", csrf.body.token as string)
    .send({ email, password: "a-secure-test-password" })
    .expect(200);
  const currentCsrf = await agent.get("/api/v1/auth/csrf").expect(200);
  return {
    agent,
    userId: response.body.user.id as string,
    cookie: cookieHeader(response),
    csrfToken: currentCsrf.body.token as string,
  };
}

async function connectSocket(cookie: string): Promise<Socket> {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie, Origin: clientOrigin },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    socket.connect();
  });
  return socket;
}

function joinConversation(socket: Socket, conversationId: string) {
  return new Promise<{ ok: boolean; error?: { code: string } }>((resolve, reject) => {
    socket.timeout(5000).emit(
      "conversation:join",
      { conversationId },
      (error: Error | null, result: { ok: boolean; error?: { code: string } }) => {
        if (error) reject(error);
        else resolve(result);
      },
    );
  });
}

function updateReadPosition(
  socket: Socket,
  conversationId: string,
  messageId: string,
  extra: Record<string, unknown> = {},
) {
  return new Promise<{ ok: boolean; messageId?: string; error?: { code: string } }>((resolve, reject) => {
    socket.timeout(5000).emit(
      "conversation:read",
      { conversationId, messageId, ...extra },
      (error: Error | null, result: { ok: boolean; messageId?: string; error?: { code: string } }) => {
        if (error) reject(error);
        else resolve(result);
      },
    );
  });
}

describe("private chat integration", () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 30_000 },
    });
    await mongoose.connect(mongo.getUri());
    await Promise.all([User.init(), Conversation.init(), Message.init()]);

    const integrationServer = createServer(app);
    server = integrationServer;
    socketServer = attachSocketServer(integrationServer);
    await new Promise<void>((resolve) => integrationServer.listen(0, "127.0.0.1", resolve));
    const address = integrationServer.address();
    if (!address || typeof address === "string") throw new Error("Could not start integration server");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      const images = await Message.find({ "image.storageKey": { $exists: true } })
        .select("image.storageKey")
        .lean();
      for (const message of images) {
        if (message.image?.storageKey) await imageStorage.delete(message.image.storageKey);
      }
    }
    await rm(imageStorageRoot, { recursive: true, force: true });
    await rm(avatarStorageRoot, { recursive: true, force: true });
    if (socketServer) {
      await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
    } else if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongo?.stop();
  });

  it("registers users, prevents duplicate conversations, persists messages, and denies outsiders", async () => {
    const limits = await request(baseUrl).get("/api/v1/limits").expect(200);
    expect(limits.body.image).toMatchObject({
      maxUploadBytes: 5 * 1024 * 1024,
      contentTypes: ["image/jpeg", "image/png", "image/webp"],
    });
    expect(limits.body.avatar).toEqual({
      maxUploadBytes: 5 * 1024 * 1024,
      contentTypes: ["image/jpeg", "image/png", "image/webp"],
    });

    const alice = await registerAccount("Alice Example", "alice@example.com");
    const bob = await registerAccount("Bob Example", "bob@example.com");
    const eve = await registerAccount("Eve Example", "eve@example.com");
    sharedAccounts = { alice, bob, eve };

    const ownProfile = await alice.agent.get("/api/v1/auth/me").expect(200);
    expect(ownProfile.body.user).toMatchObject({
      id: alice.userId,
      displayName: "Alice Example",
      email: "alice@example.com",
    });
    expect(ownProfile.body.user).not.toHaveProperty("passwordHash");

    const loginAgent = request.agent(baseUrl);
    const loginCsrf = await loginAgent.get("/api/v1/auth/csrf").expect(200);
    await loginAgent
      .post("/api/v1/auth/login")
      .set("x-csrf-token", loginCsrf.body.token as string)
      .send({ email: "alice@example.com", password: "incorrect-password" })
      .expect(401, {
        error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" },
      });
    await loginAgent
      .post("/api/v1/auth/login")
      .set("x-csrf-token", loginCsrf.body.token as string)
      .send({ email: "alice@example.com", password: "a-secure-test-password" })
      .expect(200);
    await loginAgent.get("/api/v1/auth/me").expect(200);

    const search = await alice.agent.get("/api/v1/users?search=Bob").expect(200);
    expect(search.body.users).toEqual([
      { id: bob.userId, displayName: "Bob Example", avatarUrl: null },
    ]);
    expect(search.body.users[0]).not.toHaveProperty("email");
    await User.insertMany(
      Array.from({ length: 12 }, (_, index) => ({
        displayName: `Searchable Person ${index}`,
        displayNameSearch: `searchable person ${index}`,
        email: `searchable${index}@example.com`,
        passwordHash: "test-hash-not-used-for-authentication",
      })),
    );
    const firstSearchPage = await alice.agent
      .get("/api/v1/users?search=Searchable&limit=10")
      .expect(200);
    expect(firstSearchPage.body.users).toHaveLength(10);
    expect(firstSearchPage.body.nextCursor).toBeTruthy();
    const secondSearchPage = await alice.agent
      .get(
        `/api/v1/users?search=Searchable&limit=10&cursor=${firstSearchPage.body.nextCursor as string}`,
      )
      .expect(200);
    expect(secondSearchPage.body.users).toHaveLength(2);

    const [create, duplicate] = await Promise.all([
      alice.agent
        .post("/api/v1/conversations")
        .set("x-csrf-token", alice.csrfToken)
        .send({ otherUserId: bob.userId })
        .expect(200),
      bob.agent
        .post("/api/v1/conversations")
        .set("x-csrf-token", bob.csrfToken)
        .send({ otherUserId: alice.userId })
        .expect(200),
    ]);
    const conversationId = create.body.conversation.id as string;
    expect(duplicate.body.conversation.id).toBe(conversationId);
    expect(await Conversation.countDocuments()).toBe(1);
    await Conversation.collection.updateOne({ _id: new mongoose.Types.ObjectId(conversationId) }, { $unset: { kind: "" } });
    expect((await Conversation.collection.findOne({ _id: new mongoose.Types.ObjectId(conversationId) }))?.kind)
      .toBeUndefined();

    const aliceSocket = await connectSocket(alice.cookie);
    const bobSocket = await connectSocket(bob.cookie);
    const eveSocket = await connectSocket(eve.cookie);
    const aliceJoin = await joinConversation(aliceSocket, conversationId);
    const bobJoin = await joinConversation(bobSocket, conversationId);
    const eveJoin = await joinConversation(eveSocket, conversationId);
    expect(aliceJoin.ok).toBe(true);
    expect(bobJoin.ok).toBe(true);
    expect(eveJoin).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    const clientId = "8d37f0a7-2afe-4c8b-8631-747263943942";
    const received = new Promise<{ id: string; text: string }>((resolve) => {
      bobSocket.once("message:new", resolve);
    });
    const sent = await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Hello, Bob.", clientId })
      .expect(201);
    await expect(received).resolves.toMatchObject({
      id: sent.body.message.id,
      text: "Hello, Bob.",
    });
    const receiptUpdate = new Promise<{ conversationId: string; userId: string; messageId: string }>(
      (resolve) => aliceSocket.once("receipt:updated", resolve),
    );
    await expect(updateReadPosition(bobSocket, conversationId, sent.body.message.id)).resolves.toMatchObject({
      ok: true,
      messageId: sent.body.message.id,
    });
    await expect(receiptUpdate).resolves.toMatchObject({
      conversationId,
      userId: bob.userId,
      messageId: sent.body.message.id,
    });
    const directReceipts = await alice.agent.get(`/api/v1/conversations/${conversationId}/receipts`).expect(200);
    expect(directReceipts.body.positions).toContainEqual(expect.objectContaining({
      userId: bob.userId,
      messageId: sent.body.message.id,
    }));
    const reconnectedBobSocket = await connectSocket(bob.cookie);
    expect((await joinConversation(reconnectedBobSocket, conversationId)).ok).toBe(true);
    const persistedAfterReconnect = await bob.agent
      .get(`/api/v1/conversations/${conversationId}/receipts`)
      .expect(200);
    expect(persistedAfterReconnect.body.positions).toContainEqual(expect.objectContaining({
      userId: bob.userId,
      messageId: sent.body.message.id,
    }));
    reconnectedBobSocket.disconnect();
    const directReaders = await alice.agent
      .get(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}/readers`)
      .expect(200);
    expect(directReaders.body.readers).toContainEqual({
      userId: bob.userId,
      displayName: "Bob Example",
    });
    await eve.agent.get(`/api/v1/conversations/${conversationId}/receipts`).expect(404);
    await request(baseUrl).get(`/api/v1/conversations/${conversationId}/receipts`).expect(401);
    const beforeDuplicateRead = await Conversation.findById(conversationId).select("updatedAt").lean();
    await updateReadPosition(bobSocket, conversationId, sent.body.message.id);
    const afterDuplicateRead = await Conversation.findById(conversationId).select("updatedAt").lean();
    expect(afterDuplicateRead?.updatedAt).toEqual(beforeDuplicateRead?.updatedAt);
    expect(await updateReadPosition(eveSocket, conversationId, sent.body.message.id)).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_NOT_OPEN" },
    });
    expect(await updateReadPosition(bobSocket, conversationId, sent.body.message.id, {
      userId: alice.userId,
    })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
    expect(await updateReadPosition(bobSocket, conversationId, "507f1f77bcf86cd799439099")).toMatchObject({
      ok: false,
      error: { code: "MESSAGE_NOT_FOUND" },
    });

    const retry = await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Hello, Bob.", clientId })
      .expect(201);
    expect(retry.body.message.id).toBe(sent.body.message.id);
    await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Different text", clientId })
      .expect(409);
    expect(await Message.countDocuments()).toBe(1);

    const png = await sharp({
      create: { width: 3, height: 2, channels: 3, background: "#345678" },
    }).png().toBuffer();
    await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .field("caption", "A private picture")
      .field("clientId", "599c3774-20ad-4d49-921a-7361fc011a11")
      .attach("image", png, { filename: "untrusted.jpg", contentType: "text/plain" })
      .expect(403, {
        error: { code: "CSRF_INVALID", message: "Invalid CSRF token" },
      });

    await eve.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", eve.csrfToken)
      .field("caption", "Unauthorized")
      .field("clientId", "7bc83b4e-3ce2-4af5-910c-f932c568db32")
      .attach("image", png, { filename: "picture.png", contentType: "image/png" })
      .expect(404);

    const unsupported = await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "")
      .field("clientId", "12f69cdb-2028-43dd-9f53-88f9515dd14b")
      .attach("image", Buffer.from("not an image"), { filename: "fake.png", contentType: "image/png" })
      .expect(415);
    expect(unsupported.body.error.code).toBe("IMAGE_UNSUPPORTED");

    const malformedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("malformed"),
    ]);
    await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "")
      .field("clientId", "5d597b03-3bcf-44cc-a3cb-08abca56ab21")
      .attach("image", malformedPng, { filename: "broken.png", contentType: "image/png" })
      .expect(400);

    await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "")
      .field("clientId", "cce04e13-c270-4a4f-9a29-f09bc4ef8e42")
      .attach("image", Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "large.png", contentType: "image/png" })
      .expect(413);

    const imageDelivered = new Promise<{
      id: string;
      type: string;
      text: string;
      image: { contentType: string; width: number; height: number };
    }>((resolve) => bobSocket.once("message:new", resolve));
    const imageResponse = await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "A private picture")
      .field("clientId", "8b7df90c-78ed-48f0-9d3c-047ee15f8887")
      .attach("image", png, { filename: "untrusted.jpg", contentType: "text/plain" })
      .expect(201);
    await expect(imageDelivered).resolves.toMatchObject({
      id: imageResponse.body.message.id,
      type: "image",
      text: "A private picture",
      image: { contentType: "image/png", width: 3, height: 2 },
    });
    expect(imageResponse.body.message.image).not.toHaveProperty("storageKey");
    expect(imageResponse.body.message.image).not.toHaveProperty("sha256");
    const storedImageMessage = await Message.findById(imageResponse.body.message.id).lean();
    expect(storedImageMessage?.image).toMatchObject({
      contentType: "image/png",
      size: expect.any(Number),
      width: 3,
      height: 2,
      sha256: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    const imageStorageKey = storedImageMessage?.image?.storageKey;
    expect(imageStorageKey).toMatch(
      /^converse\/[a-f\d]{24}\/[a-f\d-]{36}\.png$/,
    );

    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000);
    if (!imageStorageKey) throw new Error("Persisted image is missing its storage key");
    const referencedImagePath = resolve(imageStorageRoot, ...imageStorageKey.split("/"));
    await utimes(referencedImagePath, oldTimestamp, oldTimestamp);
    const orphanKey = `converse/${conversationId}/${randomUUID()}.png`;
    await imageStorage.put(orphanKey, png, "image/png");
    const orphanPath = resolve(imageStorageRoot, ...orphanKey.split("/"));
    await utimes(orphanPath, oldTimestamp, oldTimestamp);
    await cleanupOrphanedImages();
    await expect(imageStorage.readLocal(imageStorageKey)).resolves.toBeInstanceOf(Buffer);
    await expect(imageStorage.readLocal(orphanKey)).rejects.toMatchObject({ code: "ENOENT" });

    const imagePath = imageResponse.body.message.image.url as string;
    const privateImage = await bob.agent.get(imagePath).expect(200);
    expect(privateImage.headers["content-type"]).toContain("image/png");
    expect(privateImage.headers["cache-control"]).toBe("private, no-store");
    await eve.agent.get(imagePath).expect(404);
    const historyWithImage = await bob.agent
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .expect(200);
    expect(historyWithImage.body.messages.map((message: { id: string }) => message.id)).toEqual([
      sent.body.message.id,
      imageResponse.body.message.id,
    ]);
    const conversationPreview = await bob.agent.get("/api/v1/conversations").expect(200);
    expect(conversationPreview.body.conversations[0].latestMessage.text).toBe("A private picture");

    const imageWithoutCaption = await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("clientId", "fd846970-9641-4df4-b3b0-03b9a0df647c")
      .attach("image", png, { filename: "image.png", contentType: "image/png" })
      .expect(201);
    expect(imageWithoutCaption.body.message).toMatchObject({
      type: "image",
      text: "",
    });

    const imageRetry = await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "A private picture")
      .field("clientId", "8b7df90c-78ed-48f0-9d3c-047ee15f8887")
      .attach("image", png, { filename: "renamed.webp", contentType: "image/webp" })
      .expect(201);
    expect(imageRetry.body.message.id).toBe(imageResponse.body.message.id);

    const conflictingRetry = await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "Different content")
      .field("clientId", "8b7df90c-78ed-48f0-9d3c-047ee15f8887")
      .attach("image", png, { filename: "picture.png", contentType: "image/png" })
      .expect(409);
    expect(conflictingRetry.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await Message.countDocuments()).toBe(3);

    await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "   ", revision: sent.body.message.revision })
      .expect(400);
    await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "x".repeat(4001), revision: sent.body.message.revision })
      .expect(400);
    await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .send({ text: "No CSRF", revision: sent.body.message.revision })
      .expect(403);
    await bob.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ text: "Not mine", revision: sent.body.message.revision })
      .expect(404);
    await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/not-a-message`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Invalid ID", revision: sent.body.message.revision })
      .expect(400);
    await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Spoof sender", senderId: bob.userId, revision: sent.body.message.revision })
      .expect(400);
    const anonymousAgent = request.agent(baseUrl);
    const anonymousCsrf = await anonymousAgent.get("/api/v1/auth/csrf").expect(200);
    await anonymousAgent
      .delete(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", anonymousCsrf.body.token as string)
      .expect(401);
    await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${imageResponse.body.message.id as string}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Do not replace image", revision: imageResponse.body.message.revision })
      .expect(400);

    const concurrentEdits = await Promise.all([
      alice.agent
        .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
        .set("x-csrf-token", alice.csrfToken)
        .send({ text: "First concurrent edit", revision: sent.body.message.revision }),
      alice.agent
        .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
        .set("x-csrf-token", alice.csrfToken)
        .send({ text: "Second concurrent edit", revision: sent.body.message.revision }),
    ]);
    expect(concurrentEdits.map((result) => result.status).sort()).toEqual([200, 409]);
    const concurrentSuccess = concurrentEdits.find((result) => result.status === 200);
    if (!concurrentSuccess) throw new Error("Expected one concurrent edit to succeed");
    const editedEvent = new Promise<{ id: string; text: string; editedAt: string }>((resolve) => {
      bobSocket.once("message:updated", resolve);
    });
    const edited = await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Edited original message", revision: concurrentSuccess.body.message.revision })
      .expect(200);
    expect(edited.body.message).toMatchObject({
      id: sent.body.message.id,
      text: "Edited original message",
    });
    expect(edited.body.message.editedAt).toBeTruthy();
    await expect(editedEvent).resolves.toMatchObject({
      id: sent.body.message.id,
      text: "Edited original message",
    });
    await bob.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ text: "Forged owner", revision: edited.body.message.revision })
      .expect(404);

    const deletedEvent = new Promise<{ id: string; text: string; deletedAt: string; image?: unknown }>(
      (resolve) => bobSocket.once("message:updated", resolve),
    );
    const deletedText = await alice.agent
      .delete(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ revision: edited.body.message.revision })
      .expect(200);
    expect(deletedText.body.message).toMatchObject({
      id: sent.body.message.id,
      text: "This message was deleted.",
      deletedAt: expect.any(String),
    });
    expect(deletedText.body.message).not.toHaveProperty("image");
    await expect(deletedEvent).resolves.toMatchObject({
      id: sent.body.message.id,
      text: "This message was deleted.",
    });
    await alice.agent
      .delete(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ revision: edited.body.message.revision })
      .expect(200);
    await bob.agent
      .delete(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ revision: deletedText.body.message.revision })
      .expect(404);
    await alice.agent
      .patch(`/api/v1/conversations/${conversationId}/messages/${sent.body.message.id}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Restore deleted content", revision: deletedText.body.message.revision })
      .expect(409);
    const readPositionsAfterDelete = await bob.agent
      .get(`/api/v1/conversations/${conversationId}/receipts`)
      .expect(200);
    expect(readPositionsAfterDelete.body.positions).toContainEqual(expect.objectContaining({
      userId: bob.userId,
      messageId: sent.body.message.id,
    }));

    const imageDeleted = await alice.agent
      .delete(`/api/v1/conversations/${conversationId}/messages/${imageResponse.body.message.id as string}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ revision: imageResponse.body.message.revision })
      .expect(200);
    expect(imageDeleted.body.message).toMatchObject({
      text: "This message was deleted.",
      deletedAt: expect.any(String),
    });
    expect(imageDeleted.body.message).not.toHaveProperty("image");
    await bob.agent.get(imagePath).expect(404);
    await alice.agent
      .delete(`/api/v1/conversations/${conversationId}/messages/${imageResponse.body.message.id as string}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ revision: imageDeleted.body.message.revision })
      .expect(200);
    await cleanupOrphanedImages();
    await expect(imageStorage.readLocal(imageStorageKey)).resolves.toBeInstanceOf(Buffer);
    const deletedHistory = await bob.agent
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .expect(200);
    const deletedImageHistoryMessage = deletedHistory.body.messages.find(
      (message: { id: string }) => message.id === imageResponse.body.message.id,
    );
    expect(deletedImageHistoryMessage).toMatchObject({ text: "This message was deleted." });
    expect(deletedImageHistoryMessage).not.toHaveProperty("image");
    const deletedTextHistoryMessage = deletedHistory.body.messages.find(
      (message: { id: string }) => message.id === sent.body.message.id,
    );
    expect(deletedTextHistoryMessage).toMatchObject({ text: "This message was deleted." });
    expect(deletedHistory.body.messages.some(
      (message: { text: string }) => message.text === "Edited original message",
    )).toBe(false);
    const deletedImageRecord = await Message.findById(imageResponse.body.message.id).lean();
    expect(deletedImageRecord?.image?.storageKey).toBe(imageStorageKey);
    const latestImagePath = imageWithoutCaption.body.message.image.url as string;
    const latestImageRecord = await Message.findById(imageWithoutCaption.body.message.id).lean();
    const latestImageStorageKey = latestImageRecord?.image?.storageKey;
    if (!latestImageStorageKey) throw new Error("Latest image is missing its storage key");
    const latestImageDeleted = await alice.agent
      .delete(`/api/v1/conversations/${conversationId}/messages/${imageWithoutCaption.body.message.id as string}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ revision: imageWithoutCaption.body.message.revision })
      .expect(200);
    expect(latestImageDeleted.body.message).not.toHaveProperty("image");
    await bob.agent.get(latestImagePath).expect(404);
    const previewAfterDeletingLatest = await bob.agent.get("/api/v1/conversations").expect(200);
    expect(previewAfterDeletingLatest.body.conversations[0].latestMessage.text)
      .toBe("This message was deleted.");
    await cleanupOrphanedImages();
    await expect(imageStorage.readLocal(latestImageStorageKey)).resolves.toBeInstanceOf(Buffer);

    const noBroadcastClientId = "831a1f44-5df9-43b4-88ca-bf6d50eb78f5";
    const createSpy = vi.spyOn(Message, "create").mockRejectedValueOnce(new Error("simulated database failure"));
    let unexpectedBroadcast = false;
    const trackUnexpectedBroadcast = (message: { text: string }) => {
      if (message.text === "Should not broadcast") unexpectedBroadcast = true;
    };
    bobSocket.on("message:new", trackUnexpectedBroadcast);
    await alice.agent
      .post(`/api/v1/conversations/${conversationId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "Should not broadcast")
      .field("clientId", noBroadcastClientId)
      .attach("image", png, { filename: "picture.png", contentType: "image/png" })
      .expect(500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    bobSocket.off("message:new", trackUnexpectedBroadcast);
    createSpy.mockRestore();
    expect(unexpectedBroadcast).toBe(false);
    expect(await Message.countDocuments()).toBe(3);

    const socketDelivery = new Promise<{ senderId: string; text: string }>((resolve) => {
      aliceSocket.once("message:new", resolve);
    });
    const socketAcknowledgement = new Promise<{
      ok: boolean;
      message?: { senderId: string; text: string };
    }>((resolve, reject) => {
      bobSocket.timeout(5000).emit(
        "message:send",
        {
          conversationId,
          text: "A real-time reply",
          clientId: "59018925-6411-4df4-befe-c8e21962a9b0",
        },
        (error: Error | null, result: { ok: boolean; message?: { senderId: string; text: string } }) => {
          if (error) reject(error);
          else resolve(result);
        },
      );
    });
    const [delivered, acknowledgement] = await Promise.all([socketDelivery, socketAcknowledgement]);
    expect(acknowledgement).toMatchObject({
      ok: true,
      message: { senderId: bob.userId, text: "A real-time reply" },
    });
    expect(delivered).toMatchObject({ senderId: bob.userId, text: "A real-time reply" });
    expect(await Message.countDocuments()).toBe(4);

    const conversationList = await alice.agent.get("/api/v1/conversations").expect(200);
    expect(conversationList.body.conversations[0]).toMatchObject({
      id: conversationId,
      latestMessage: { text: "A real-time reply" },
    });

    await Message.insertMany(
      [0, 1, 2].map((index) => ({
        conversationId,
        senderId: alice.userId,
        text: `Earlier message ${index}`,
        idempotencyKey: `history-${index}`,
        createdAt: new Date(`2020-01-0${index + 1}T00:00:00.000Z`),
      })),
    );
    const firstPage = await bob.agent
      .get(`/api/v1/conversations/${conversationId}/messages?limit=2`)
      .expect(200);
    expect(firstPage.body.messages).toHaveLength(2);
    expect(firstPage.body.nextCursor).toBeTruthy();
    const secondPage = await bob.agent
      .get(
        `/api/v1/conversations/${conversationId}/messages?limit=2&before=${encodeURIComponent(firstPage.body.nextCursor as string)}`,
      )
      .expect(200);
    expect(secondPage.body.messages).toHaveLength(2);
    expect(secondPage.body.nextCursor).toBeTruthy();

    const history = await bob.agent
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .expect(200);
    expect(history.body.messages).toHaveLength(7);

    await eve.agent.get(`/api/v1/conversations/${conversationId}/messages`).expect(404);
    await eve.agent
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("x-csrf-token", eve.csrfToken)
      .send({ text: "Intrusion", clientId: "aa5b56cc-58c8-487a-a037-63551c13e38c" })
      .expect(404);

    const disconnected = new Promise<void>((resolve) => bobSocket.once("disconnect", () => resolve()));
    await bob.agent.post("/api/v1/auth/logout").set("x-csrf-token", bob.csrfToken).expect(204);
    await disconnected;
    await bob.agent.get("/api/v1/auth/me").expect(401);
    aliceSocket.disconnect();
    eveSocket.disconnect();
  });

  it("creates secure groups, persists group messages, enforces roles, and archives empty groups", async () => {
    if (!sharedAccounts) throw new Error("Expected private chat test accounts");
    const alice = sharedAccounts.alice;
    const bob = await loginAccount("bob@example.com");
    const eve = sharedAccounts.eve;
    const dave = await createFixtureAccount("Group Dave", "group-dave@example.com");

    await alice.agent
      .post("/api/v1/conversations/groups")
      .set("x-csrf-token", alice.csrfToken)
      .send({ name: "Too small", memberIds: [bob.userId] })
      .expect(400);
    await alice.agent
      .post("/api/v1/conversations/groups")
      .set("x-csrf-token", alice.csrfToken)
      .send({ name: "Self invite", memberIds: [bob.userId, alice.userId] })
      .expect(400);
    await alice.agent
      .post("/api/v1/conversations/groups")
      .send({ name: "Missing CSRF", memberIds: [bob.userId, eve.userId] })
      .expect(403);

    const created = await alice.agent
      .post("/api/v1/conversations/groups")
      .set("x-csrf-token", alice.csrfToken)
      .send({ name: "Weekend plans", memberIds: [bob.userId, eve.userId] })
      .expect(201);
    const groupId = created.body.conversation.id as string;
    expect(created.body.conversation).toMatchObject({
      kind: "group",
      name: "Weekend plans",
      currentRole: "admin",
      members: [
        { userId: alice.userId, displayName: "Alice Example", role: "admin" },
        { userId: bob.userId, displayName: "Bob Example", role: "member" },
        { userId: eve.userId, displayName: "Eve Example", role: "member" },
      ],
    });
    const groupRecord = await Conversation.findById(groupId).lean();
    expect(groupRecord?.pairKey).toBe(`group:${groupId}`);
    expect(groupRecord?.photoReference).toBeNull();
    expect(groupRecord?.creatorId?.toString()).toBe(alice.userId);
    expect(groupRecord?.createdAt).toBeInstanceOf(Date);
    expect(groupRecord?.updatedAt).toBeInstanceOf(Date);

    await bob.agent.get(`/api/v1/conversations/groups/${groupId}`).expect(200);
    await dave.agent.get(`/api/v1/conversations/groups/${groupId}`).expect(404);
    const outsiderConversations = await dave.agent.get("/api/v1/conversations").expect(200);
    expect(outsiderConversations.body.conversations).toHaveLength(0);
    const bobRename = await bob.agent
      .patch(`/api/v1/conversations/groups/${groupId}`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ name: "Unauthorized rename" })
      .expect(403);
    expect(bobRename.body.error.code).toBe("GROUP_ADMIN_REQUIRED");
    await bob.agent
      .post(`/api/v1/conversations/groups/${groupId}/members`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ memberIds: [dave.userId] })
      .expect(403);

    const renamed = await alice.agent
      .patch(`/api/v1/conversations/groups/${groupId}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ name: "Updated plans" })
      .expect(200);
    expect(renamed.body.conversation.name).toBe("Updated plans");
    const aliceSocket = await connectSocket(alice.cookie);
    const bobSocket = await connectSocket(bob.cookie);
    const eveSocket = await connectSocket(eve.cookie);
    const daveSocket = await connectSocket(dave.cookie);
    expect((await joinConversation(aliceSocket, groupId)).ok).toBe(true);
    expect((await joinConversation(bobSocket, groupId)).ok).toBe(true);
    expect((await joinConversation(eveSocket, groupId)).ok).toBe(true);
    expect(await joinConversation(daveSocket, groupId)).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    const bobReceived = new Promise<{ id: string; text: string; sender?: { displayName: string } }>(
      (resolve) => bobSocket.once("message:new", resolve),
    );
    const eveReceived = new Promise<{ id: string }>((resolve) => eveSocket.once("message:new", resolve));
    const firstMessage = await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Hello group", clientId: randomUUID() })
      .expect(201);
    await expect(bobReceived).resolves.toMatchObject({
      id: firstMessage.body.message.id,
      text: "Hello group",
      sender: { displayName: "Alice Example" },
    });
    await expect(eveReceived).resolves.toMatchObject({ id: firstMessage.body.message.id });
    const groupHistory = await bob.agent.get(`/api/v1/conversations/${groupId}/messages`).expect(200);
    expect(groupHistory.body.messages[0]).toMatchObject({
      text: "Hello group",
      sender: { displayName: "Alice Example" },
    });
    const directConversation = await Conversation.findOne({
      kind: "direct",
      participants: { $all: [new mongoose.Types.ObjectId(alice.userId), new mongoose.Types.ObjectId(bob.userId)] },
    }).select("_id").lean();
    if (!directConversation) throw new Error("Expected the Alice-Bob direct conversation");
    const directId = directConversation._id.toString();
    expect((await joinConversation(aliceSocket, directId)).ok).toBe(true);
    expect((await joinConversation(bobSocket, directId)).ok).toBe(true);

    const replied = await bob.agent
      .post(`/api/v1/conversations/${groupId}/messages`)
      .set("x-csrf-token", bob.csrfToken)
      .send({
        text: "A reply in the group",
        clientId: randomUUID(),
        replyToMessageId: firstMessage.body.message.id,
      })
      .expect(201);
    expect(replied.body.message.reply).toMatchObject({
      id: firstMessage.body.message.id,
      senderName: "Alice Example",
      text: "Hello group",
      type: "text",
    });
    const directMessageForReply = await Message.findOne({
      conversationId: directId,
      senderId: new mongoose.Types.ObjectId(alice.userId),
      deletedAt: { $exists: false },
    }).select("_id __v").lean();
    if (!directMessageForReply) throw new Error("Expected an Alice direct message for cross-conversation test");
    await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages`)
      .set("x-csrf-token", alice.csrfToken)
      .send({
        text: "Cross-conversation reply",
        clientId: randomUUID(),
        replyToMessageId: directMessageForReply._id.toString(),
      })
      .expect(404);

    const pinUpdate = new Promise<{ id: string; pinnedAt?: string }>((resolve) => {
      bobSocket.once("message:updated", resolve);
    });
    const [pinned, simultaneousPin] = await Promise.all([
      bob.agent
        .put(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/pin`)
        .set("x-csrf-token", bob.csrfToken)
        .send({ pinned: true })
        .expect(200),
      alice.agent
        .put(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/pin`)
        .set("x-csrf-token", alice.csrfToken)
        .send({ pinned: true })
        .expect(200),
    ]);
    expect(pinned.body.message.pinnedAt).toBeTruthy();
    expect(simultaneousPin.body.message.pinnedAt).toBe(pinned.body.message.pinnedAt);
    await expect(pinUpdate).resolves.toMatchObject({
      id: firstMessage.body.message.id,
      pinnedAt: pinned.body.message.pinnedAt,
    });
    const pinnedAt = pinned.body.message.pinnedAt;
    const duplicatePin = await alice.agent
      .put(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/pin`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ pinned: true })
      .expect(200);
    expect(duplicatePin.body.message.pinnedAt).toBe(pinnedAt);
    await dave.agent
      .put(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/pin`)
      .set("x-csrf-token", dave.csrfToken)
      .send({ pinned: true })
      .expect(404);
    await bob.agent
      .put(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/pin`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ pinned: false })
      .expect(200);

    const forwardedEvent = new Promise<{ conversationId: string; senderId: string; forwardedFrom?: { senderName: string } }>(
      (resolve) => aliceSocket.once("message:new", resolve),
    );
    const forwardClientId = randomUUID();
    const forwarded = await bob.agent
      .post(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/forward`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ destinationConversationId: directId, clientId: forwardClientId })
      .expect(201);
    expect(forwarded.body.message).toMatchObject({
      conversationId: directId,
      senderId: bob.userId,
      text: "Hello group",
      forwardedFrom: { senderName: "Alice Example" },
    });
    const forwardedRetry = await bob.agent
      .post(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/forward`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ destinationConversationId: directId, clientId: forwardClientId })
      .expect(201);
    expect(forwardedRetry.body.message.id).toBe(forwarded.body.message.id);
    await expect(forwardedEvent).resolves.toMatchObject({
      conversationId: directId,
      senderId: bob.userId,
      forwardedFrom: { senderName: "Alice Example" },
    });
    const forwardHistory = await alice.agent.get(`/api/v1/conversations/${directId}/messages`).expect(200);
    expect(forwardHistory.body.messages.some((message: { id: string }) => message.id === forwarded.body.message.id))
      .toBe(true);
    for (let requestIndex = 0; requestIndex < 18; requestIndex += 1) {
      await bob.agent
        .post(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/forward`)
        .set("x-csrf-token", bob.csrfToken)
        .send({
          destinationConversationId: directId,
          clientId: "3f902224-d622-49b7-9f7f-b57ab0471d26",
        })
        .expect(201);
    }
    const blockedForward = await bob.agent
      .post(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/forward`)
      .set("x-csrf-token", bob.csrfToken)
      .send({
        destinationConversationId: directId,
        clientId: randomUUID(),
        userId: alice.userId,
      })
      .expect(429);
    expect(blockedForward.body).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many forwards. Please try again in a minute.",
      },
    });
    const isolatedForward = await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/forward`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ destinationConversationId: directId, clientId: randomUUID() })
      .expect(201);
    expect(isolatedForward.body.message.senderId).toBe(alice.userId);
    await eve.agent
      .post(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/forward`)
      .set("x-csrf-token", eve.csrfToken)
      .send({ destinationConversationId: directId, clientId: randomUUID() })
      .expect(404);
    await dave.agent
      .post(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/forward`)
      .set("x-csrf-token", dave.csrfToken)
      .send({ destinationConversationId: directId, clientId: randomUUID() })
      .expect(404);

    const directMessage = await Message.findOne({
      conversationId: { $ne: new mongoose.Types.ObjectId(groupId) },
      senderId: new mongoose.Types.ObjectId(alice.userId),
    }).select("_id __v").lean();
    if (!directMessage) throw new Error("Expected an Alice direct message for cross-conversation test");
    await alice.agent
      .patch(`/api/v1/conversations/${groupId}/messages/${directMessage._id.toString()}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Cross-conversation edit", revision: directMessage.__v ?? 0 })
      .expect(404);
    await expect(updateReadPosition(bobSocket, groupId, firstMessage.body.message.id)).resolves.toMatchObject({
      ok: true,
    });
    await expect(updateReadPosition(eveSocket, groupId, firstMessage.body.message.id)).resolves.toMatchObject({
      ok: true,
    });
    const firstMessageReaders = await alice.agent
      .get(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/readers`)
      .expect(200);
    expect(firstMessageReaders.body.readers.map((reader: { userId: string }) => reader.userId).sort())
      .toEqual([bob.userId, eve.userId].sort());

    await alice.agent
      .post(`/api/v1/conversations/groups/${groupId}/members`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ memberIds: [dave.userId] })
      .expect(200);
    await alice.agent
      .post(`/api/v1/conversations/groups/${groupId}/members`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ memberIds: [dave.userId.toUpperCase()] })
      .expect(409);
    expect((await joinConversation(daveSocket, groupId)).ok).toBe(true);
    const readersAfterJoin = await alice.agent
      .get(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/readers`)
      .expect(200);
    expect(readersAfterJoin.body.readers.map((reader: { userId: string }) => reader.userId).sort())
      .toEqual([bob.userId, eve.userId].sort());

    await alice.agent
      .delete(`/api/v1/conversations/groups/${groupId}/members/${eve.userId}`)
      .set("x-csrf-token", alice.csrfToken)
      .expect(200);
    await eve.agent.get(`/api/v1/conversations/groups/${groupId}`).expect(404);
    await eve.agent.get(`/api/v1/conversations/${groupId}/messages`).expect(404);
    await eve.agent
      .put(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/pin`)
      .set("x-csrf-token", eve.csrfToken)
      .send({ pinned: true })
      .expect(404);
    await eve.agent
      .post(`/api/v1/conversations/${groupId}/messages`)
      .set("x-csrf-token", eve.csrfToken)
      .send({ text: "Removed member", clientId: randomUUID() })
      .expect(404);
    await eve.agent.get(`/api/v1/conversations/${groupId}/receipts`).expect(404);
    await eve.agent
      .get(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/readers`)
      .expect(404);
    const readersAfterRemoval = await alice.agent
      .get(`/api/v1/conversations/${groupId}/messages/${firstMessage.body.message.id}/readers`)
      .expect(200);
    expect(readersAfterRemoval.body.readers.map((reader: { userId: string }) => reader.userId))
      .toEqual([bob.userId]);
    expect(await joinConversation(eveSocket, groupId)).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    let removedMemberReceived = false;
    eveSocket.on("message:new", (message: { conversationId: string }) => {
      if (message.conversationId === groupId) removedMemberReceived = true;
    });
    const bobReceivedAfterRemoval = new Promise<{ text: string }>((resolve) => {
      bobSocket.once("message:new", resolve);
    });
    const currentMembersMessage = await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ text: "Current members only", clientId: randomUUID() })
      .expect(201);
    await expect(bobReceivedAfterRemoval).resolves.toMatchObject({ text: "Current members only" });
    await updateReadPosition(bobSocket, groupId, currentMembersMessage.body.message.id as string);
    await Promise.all([
      updateReadPosition(bobSocket, groupId, firstMessage.body.message.id as string),
      updateReadPosition(bobSocket, groupId, currentMembersMessage.body.message.id as string),
    ]);
    const monotonicReceipts = await bob.agent.get(`/api/v1/conversations/${groupId}/receipts`).expect(200);
    expect(monotonicReceipts.body.positions).toContainEqual(expect.objectContaining({
      userId: bob.userId,
      messageId: currentMembersMessage.body.message.id,
    }));
    await bob.agent
      .patch(`/api/v1/conversations/${groupId}/messages/${currentMembersMessage.body.message.id as string}`)
      .set("x-csrf-token", bob.csrfToken)
      .send({ text: "Not the sender's message", revision: currentMembersMessage.body.message.revision })
      .expect(404);
    await bob.agent
      .post(`/api/v1/conversations/${groupId}/messages`)
      .set("x-csrf-token", bob.csrfToken)
      .send({
        text: "Reply to a message that will be deleted",
        clientId: randomUUID(),
        replyToMessageId: currentMembersMessage.body.message.id,
      })
      .expect(201);
    const groupDeletion = await alice.agent
      .delete(`/api/v1/conversations/${groupId}/messages/${currentMembersMessage.body.message.id as string}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ revision: currentMembersMessage.body.message.revision })
      .expect(200);
    expect(groupDeletion.body.message.text).toBe("This message was deleted.");
    const historyAfterReplyTargetDeletion = await bob.agent
      .get(`/api/v1/conversations/${groupId}/messages`)
      .expect(200);
    expect(historyAfterReplyTargetDeletion.body.messages.find(
      (message: { text: string }) => message.text === "Reply to a message that will be deleted",
    )?.reply).toMatchObject({ text: "This message was deleted." });
    await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages/${currentMembersMessage.body.message.id as string}/forward`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ destinationConversationId: directId, clientId: randomUUID() })
      .expect(404);
    const groupReceiptAfterDelete = await bob.agent
      .get(`/api/v1/conversations/${groupId}/receipts`)
      .expect(200);
    expect(groupReceiptAfterDelete.body.positions).toContainEqual(expect.objectContaining({
      userId: bob.userId,
      messageId: currentMembersMessage.body.message.id,
    }));
    const aliceReceivedSocketMessage = new Promise<{ senderId: string; text: string }>((resolve) => {
      aliceSocket.once("message:new", resolve);
    });
    const socketAck = new Promise<{
      ok: boolean;
      message?: { senderId: string; text: string };
      error?: { code: string };
    }>((resolve, reject) => {
      bobSocket.timeout(5000).emit(
        "message:send",
        {
          conversationId: groupId,
          text: "Group socket message",
          clientId: randomUUID(),
          senderId: alice.userId,
        },
        (error: Error | null, result: {
          ok: boolean;
          message?: { senderId: string; text: string };
          error?: { code: string };
        }) => error ? reject(error) : resolve(result),
      );
    });
    await expect(socketAck).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
    const socketDelivery = new Promise<{ senderId: string; text: string }>((resolve, reject) => {
      bobSocket.timeout(5000).emit(
        "message:send",
        { conversationId: groupId, text: "Group socket message", clientId: randomUUID() },
        (error: Error | null, result: { ok: boolean; message?: { senderId: string; text: string } }) => {
          if (error) {
            reject(error);
            return;
          }
          if (!result.ok || !result.message) {
            reject(new Error("Group socket message was rejected"));
            return;
          }
          resolve(result.message);
        },
      );
    });
    const [deliveredToAlice, sentFromSocket] = await Promise.all([
      aliceReceivedSocketMessage,
      socketDelivery,
    ]);
    expect(deliveredToAlice).toMatchObject({ senderId: bob.userId, text: "Group socket message" });
    expect(sentFromSocket).toMatchObject({ senderId: bob.userId, text: "Group socket message" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(removedMemberReceived).toBe(false);

    const png = await sharp({
      create: { width: 3, height: 2, channels: 3, background: "#345678" },
    }).png().toBuffer();
    const groupImageReceived = new Promise<{ type: string; text: string }>((resolve) => {
      bobSocket.once("message:new", resolve);
    });
    const groupImageResponse = await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages/image`)
      .set("x-csrf-token", alice.csrfToken)
      .field("caption", "Group image")
      .field("clientId", randomUUID())
      .attach("image", png, { filename: "group.png", contentType: "image/png" })
      .expect(201);
    const groupImageUrl = groupImageResponse.body.message.image.url as string;
    await expect(groupImageReceived).resolves.toMatchObject({ type: "image", text: "Group image" });
    await updateReadPosition(bobSocket, groupId, groupImageResponse.body.message.id as string);
    const groupImageReaders = await alice.agent
      .get(`/api/v1/conversations/${groupId}/messages/${groupImageResponse.body.message.id as string}/readers`)
      .expect(200);
    expect(groupImageReaders.body.readers).toContainEqual(expect.objectContaining({ userId: bob.userId }));
    await eve.agent.get(groupImageUrl).expect(404);
    const imageReadSpy = vi.spyOn(imageStorage, "read");
    try {
      await bob.agent
        .post(`/api/v1/conversations/${groupId}/messages/${groupImageResponse.body.message.id as string}/forward`)
        .set("x-csrf-token", bob.csrfToken)
        .send({ destinationConversationId: directId, clientId: randomUUID() })
        .expect(429);
      expect(imageReadSpy).not.toHaveBeenCalled();
    } finally {
      imageReadSpy.mockRestore();
    }
    let failedCopyStorageKey: string | undefined;
    const originalPut = imageStorage.put.bind(imageStorage);
    const putSpy = vi.spyOn(imageStorage, "put").mockImplementation(async (key, ...args) => {
      failedCopyStorageKey = key;
      await originalPut(key, ...args);
    });
    const createSpy = vi.spyOn(Message, "create").mockRejectedValueOnce(new Error("simulated database failure"));
    try {
      await alice.agent
        .post(`/api/v1/conversations/${groupId}/messages/${groupImageResponse.body.message.id as string}/forward`)
        .set("x-csrf-token", alice.csrfToken)
        .send({ destinationConversationId: directId, clientId: randomUUID() })
        .expect(500);
    } finally {
      createSpy.mockRestore();
      putSpy.mockRestore();
    }
    expect(failedCopyStorageKey).toBeTruthy();
    if (!failedCopyStorageKey) throw new Error("Forwarded image cleanup did not capture its storage key");
    await expect(imageStorage.readLocal(failedCopyStorageKey)).rejects.toThrow();

    const forwardedImage = await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages/${groupImageResponse.body.message.id as string}/forward`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ destinationConversationId: directId, clientId: randomUUID() })
      .expect(201);
    expect(forwardedImage.body.message).toMatchObject({
      conversationId: directId,
      senderId: alice.userId,
      text: "Group image",
      forwardedFrom: { senderName: "Alice Example" },
    });
    expect(forwardedImage.body.message.image.url).toContain(`/conversations/${directId}/messages/`);
    const [sourceImageRecord, copiedImageRecord] = await Promise.all([
      Message.findById(groupImageResponse.body.message.id).select("image.storageKey").lean(),
      Message.findById(forwardedImage.body.message.id).select("image.storageKey").lean(),
    ]);
    expect(copiedImageRecord?.image?.storageKey).toBeTruthy();
    expect(copiedImageRecord?.image?.storageKey).not.toBe(sourceImageRecord?.image?.storageKey);
    await bob.agent.get(forwardedImage.body.message.image.url as string).expect(200);
    const deletedSourceImage = await alice.agent
      .delete(`/api/v1/conversations/${groupId}/messages/${groupImageResponse.body.message.id as string}`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ revision: groupImageResponse.body.message.revision })
      .expect(200);
    expect(deletedSourceImage.body.message).not.toHaveProperty("image");
    await alice.agent
      .post(`/api/v1/conversations/${groupId}/messages/${groupImageResponse.body.message.id as string}/forward`)
      .set("x-csrf-token", alice.csrfToken)
      .send({ destinationConversationId: directId, clientId: randomUUID() })
      .expect(404);
    await bob.agent.get(forwardedImage.body.message.image.url as string).expect(200);

    const aliceLeave = await alice.agent
      .post(`/api/v1/conversations/groups/${groupId}/leave`)
      .set("x-csrf-token", alice.csrfToken)
      .expect(200);
    expect(aliceLeave.body.archived).toBe(false);
    const promotedGroup = await bob.agent.get(`/api/v1/conversations/groups/${groupId}`).expect(200);
    expect(promotedGroup.body.conversation.currentRole).toBe("admin");
    await bob.agent
      .delete(`/api/v1/conversations/groups/${groupId}/members/${dave.userId}`)
      .set("x-csrf-token", bob.csrfToken)
      .expect(200);
    const finalLeave = await bob.agent
      .post(`/api/v1/conversations/groups/${groupId}/leave`)
      .set("x-csrf-token", bob.csrfToken)
      .expect(200);
    expect(finalLeave.body.archived).toBe(true);
    await bob.agent.get(`/api/v1/conversations/groups/${groupId}`).expect(404);
    expect(await Message.countDocuments({ conversationId: groupId })).toBe(6);

    aliceSocket.disconnect();
    bobSocket.disconnect();
    eveSocket.disconnect();
    daveSocket.disconnect();
  });

  it("secures group photo uploads, replacement, removal, storage cleanup, and realtime updates", async () => {
    if (!sharedAccounts) throw new Error("Expected private chat test accounts");
    const { alice, eve } = sharedAccounts;
    const bob = await loginAccount("bob@example.com");
    const outsider = await createFixtureAccount("Photo outsider", "photo-outsider@example.com");
    const groupResponse = await alice.agent
      .post("/api/v1/conversations/groups")
      .set("x-csrf-token", alice.csrfToken)
      .send({ name: "Photo test group", memberIds: [bob.userId, eve.userId] })
      .expect(201);
    const groupId = groupResponse.body.conversation.id as string;
    const photoPath = `/api/v1/conversations/groups/${groupId}/photo`;
    await alice.agent.get("/api/v1/conversations/groups/not-an-id/photo").expect(400);
    const directConversation = await Conversation.findOne({ kind: { $ne: "group" } }).select("_id").lean();
    if (directConversation) {
      const directPhotoPath = `/api/v1/conversations/groups/${directConversation._id.toString()}/photo`;
      await alice.agent.get(directPhotoPath).expect(404);
      await alice.agent
        .put(directPhotoPath)
        .set("x-csrf-token", alice.csrfToken)
        .attach("photo", Buffer.from("ignored"), { filename: "ignored.jpg", contentType: "image/jpeg" })
        .expect(404);
    }

    const png = await sharp({
      create: { width: 80, height: 48, channels: 3, background: "#4765ca" },
    }).png().toBuffer();
    const jpeg = await sharp({
      create: { width: 56, height: 96, channels: 3, background: "#21a277" },
    }).jpeg().toBuffer();

    await alice.agent
      .put(photoPath)
      .attach("photo", png, { filename: "missing-csrf.png", contentType: "image/png" })
      .expect(403);
    await bob.agent
      .put(photoPath)
      .set("x-csrf-token", bob.csrfToken)
      .attach("photo", png, { filename: "member.png", contentType: "image/png" })
      .expect(403);
    await bob.agent
      .delete(photoPath)
      .set("x-csrf-token", bob.csrfToken)
      .expect(403);
    await outsider.agent
      .put(photoPath)
      .set("x-csrf-token", outsider.csrfToken)
      .attach("photo", png, { filename: "outsider.png", contentType: "image/png" })
      .expect(404);
    await outsider.agent.get(photoPath).expect(404);

    await alice.agent
      .put(photoPath)
      .set("x-csrf-token", alice.csrfToken)
      .attach("photo", Buffer.from("not an image"), { filename: "invalid.png", contentType: "image/png" })
      .expect(415);
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await alice.agent
      .put(photoPath)
      .set("x-csrf-token", alice.csrfToken)
      .attach("photo", pngSignature, { filename: "damaged.png", contentType: "image/png" })
      .expect(400);
    await alice.agent
      .put(photoPath)
      .set("x-csrf-token", alice.csrfToken)
      .attach("photo", Buffer.alloc(env.AVATAR_MAX_UPLOAD_BYTES + 1), {
        filename: "large.png",
        contentType: "image/png",
      })
      .expect(413);

    const aliceSocket = await connectSocket(alice.cookie);
    const bobSocket = await connectSocket(bob.cookie);
    const eveSocket = await connectSocket(eve.cookie);
    const outsiderSocket = await connectSocket(outsider.cookie);
    const aliceUpdate = new Promise<{ conversationId: string }>((resolve) => {
      aliceSocket.once("group:updated", resolve);
    });
    const bobUpdate = new Promise<{ conversationId: string }>((resolve) => {
      bobSocket.once("group:updated", resolve);
    });
    let outsiderReceivedUpdate = false;
    outsiderSocket.on("group:updated", ({ conversationId }: { conversationId: string }) => {
      if (conversationId === groupId) outsiderReceivedUpdate = true;
    });

    const uploaded = await alice.agent
      .put(photoPath)
      .set("x-csrf-token", alice.csrfToken)
      .attach("photo", png, { filename: "group.png", contentType: "image/png" })
      .expect(200);
    expect(uploaded.body.conversation.photoUrl).toMatch(
      new RegExp(`^${photoPath.replaceAll("/", "\\/")}\\?v=`),
    );
    expect(uploaded.body.conversation.photoReference).toMatch(
      /^[0-9a-f-]{36}\.webp$/,
    );
    expect(await aliceUpdate).toEqual({ conversationId: groupId });
    expect(await bobUpdate).toEqual({ conversationId: groupId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outsiderReceivedUpdate).toBe(false);

    const firstGroup = await Conversation.findById(groupId).lean();
    const firstKey = firstGroup?.photoReference;
    if (!firstKey) throw new Error("Group photo was not persisted");
    expect(existsSync(join(avatarStorageRoot, firstKey))).toBe(true);
    const memberPhoto = await eve.agent.get(uploaded.body.conversation.photoUrl as string).expect(200);
    expect(memberPhoto.headers["content-type"]).toContain("image/webp");
    expect(await sharp(memberPhoto.body as Buffer).metadata()).toMatchObject({
      format: "webp",
      width: 512,
      height: 512,
    });
    await request(baseUrl).get(uploaded.body.conversation.photoUrl as string).expect(401);

    await alice.agent
      .delete(`/api/v1/conversations/groups/${groupId}/members/${eve.userId}`)
      .set("x-csrf-token", alice.csrfToken)
      .expect(200);
    await eve.agent.get(uploaded.body.conversation.photoUrl as string).expect(404);
    let removedMemberReceivedUpdate = false;
    eveSocket.on("group:updated", ({ conversationId }: { conversationId: string }) => {
      if (conversationId === groupId) removedMemberReceivedUpdate = true;
    });
    const aliceReplacementUpdate = new Promise<{ conversationId: string }>((resolve) => {
      aliceSocket.once("group:updated", resolve);
    });
    const bobReplacementUpdate = new Promise<{ conversationId: string }>((resolve) => {
      bobSocket.once("group:updated", resolve);
    });

    const cleanup = vi.spyOn(avatarService, "deleteAvatarIfUnreferenced")
      .mockRejectedValueOnce(new Error("simulated storage cleanup failure"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const replacement = await alice.agent
      .put(photoPath)
      .set("x-csrf-token", alice.csrfToken)
      .attach("photo", jpeg, { filename: "replacement.jpg", contentType: "image/jpeg" })
      .expect(200);
    expect(await aliceReplacementUpdate).toEqual({ conversationId: groupId });
    expect(await bobReplacementUpdate).toEqual({ conversationId: groupId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(removedMemberReceivedUpdate).toBe(false);
    cleanup.mockRestore();
    errorLog.mockRestore();

    const replacedGroup = await Conversation.findById(groupId).lean();
    const replacementKey = replacedGroup?.photoReference;
    if (!replacementKey) throw new Error("Replacement group photo was not persisted");
    expect(replacementKey).not.toBe(firstKey);
    expect(replacement.body.conversation.photoUrl).not.toBe(uploaded.body.conversation.photoUrl);
    expect(existsSync(join(avatarStorageRoot, replacementKey))).toBe(true);
    expect(existsSync(join(avatarStorageRoot, firstKey))).toBe(true);
    await avatarService.deleteAvatarIfUnreferenced(firstKey);
    expect(existsSync(join(avatarStorageRoot, firstKey))).toBe(false);
    await avatarService.cleanupOrphanedAvatars();
    expect(existsSync(join(avatarStorageRoot, replacementKey))).toBe(true);

    const removed = await alice.agent
      .delete(photoPath)
      .set("x-csrf-token", alice.csrfToken)
      .expect(200);
    expect(removed.body.conversation.photoReference).toBeNull();
    expect(removed.body.conversation.photoUrl).toBeNull();
    expect(existsSync(join(avatarStorageRoot, replacementKey))).toBe(false);
    await bob.agent.get(uploaded.body.conversation.photoUrl as string).expect(404);

    const brokenKey = `${randomUUID()}.webp`;
    await Conversation.updateOne({ _id: groupId }, { $set: { photoReference: brokenKey } });
    const brokenGroup = await alice.agent.get(`/api/v1/conversations/groups/${groupId}`).expect(200);
    expect(brokenGroup.body.conversation.photoUrl).toContain(encodeURIComponent(brokenKey));
    await alice.agent.get(brokenGroup.body.conversation.photoUrl as string).expect(404);

    aliceSocket.disconnect();
    bobSocket.disconnect();
    eveSocket.disconnect();
    outsiderSocket.disconnect();
  });

  it("paginates shared media for group members without exposing deleted or other-conversation images", async () => {
    const alice = await createFixtureAccount("Gallery Alice", "gallery-alice@example.com");
    const bob = await createFixtureAccount("Gallery Bob", "gallery-bob@example.com");
    const eve = await createFixtureAccount("Gallery Eve", "gallery-eve@example.com");
    const outsider = await createFixtureAccount("Media Outsider", "media-outsider@example.com");
    const groupResponse = await alice.agent
      .post("/api/v1/conversations/groups")
      .set("x-csrf-token", alice.csrfToken)
      .send({ name: "Shared media", memberIds: [bob.userId, eve.userId] })
      .expect(201);
    const groupId = groupResponse.body.conversation.id as string;
    const otherGroupResponse = await eve.agent
      .post("/api/v1/conversations/groups")
      .set("x-csrf-token", eve.csrfToken)
      .send({ name: "Other media", memberIds: [alice.userId, bob.userId] })
      .expect(201);
    const otherGroupId = otherGroupResponse.body.conversation.id as string;
    await User.updateOne({ _id: eve.userId }, { $set: { bio: "A short gallery bio" } });
    const directConversation = await alice.agent
      .post("/api/v1/conversations")
      .set("x-csrf-token", alice.csrfToken)
      .send({ otherUserId: eve.userId })
      .expect(200);
    const conversations = await alice.agent.get("/api/v1/conversations").expect(200);
    expect(conversations.body.conversations.find(
      (item: { id: string }) => item.id === directConversation.body.conversation.id,
    ).otherUser.bio).toBe("A short gallery bio");
    const galleryMessages = Array.from({ length: 26 }, (_, index) => ({
      conversationId: groupId,
      senderId: index % 2 === 0 ? alice.userId : bob.userId,
      type: "image" as const,
      text: "",
      image: {
        storageKey: `converse/${groupId}/${randomUUID()}.png`,
        contentType: "image/png" as const,
        size: 128,
        width: 3,
        height: 2,
        sha256: "a".repeat(64),
      },
      idempotencyKey: randomUUID(),
      createdAt: new Date(Date.now() + index * 1000),
      ...(index === 25 ? { deletedAt: new Date() } : {}),
    }));
    const [deletedImage] = await Message.insertMany(galleryMessages.filter((_, index) => index === 25));
    if (!deletedImage) throw new Error("Expected the deleted image fixture to be inserted");
    await Message.insertMany(galleryMessages.filter((_, index) => index !== 25));
    const otherConversationImage = await Message.create({
      conversationId: otherGroupId,
      senderId: eve.userId,
      type: "image",
      text: "",
      image: {
        storageKey: `converse/${otherGroupId}/${randomUUID()}.png`,
        contentType: "image/png",
        size: 128,
        width: 3,
        height: 2,
        sha256: "b".repeat(64),
      },
      idempotencyKey: randomUUID(),
    });
    const mediaPath = `/api/v1/conversations/${groupId}/media`;

    await request(baseUrl).get(mediaPath).expect(401);
    await outsider.agent.get(mediaPath).expect(404);
    await bob.agent.get(`/api/v1/conversations/${groupId}/media?limit=0`).expect(400);
    await alice.agent
      .get(`/api/v1/conversations/${groupId}/messages/${deletedImage._id.toString()}/image`)
      .expect(404);

    const firstPage = await alice.agent.get(mediaPath).query({ limit: 10 }).expect(200);
    expect(firstPage.body.messages).toHaveLength(10);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    expect(firstPage.body.messages.every((message: { image: { url: string } }) =>
      message.image.url.startsWith(`/api/v1/conversations/${groupId}/messages/`),
    )).toBe(true);
    expect(JSON.stringify(firstPage.body)).not.toContain("storageKey");
    expect(firstPage.body.messages.map((message: { id: string }) => message.id))
      .not.toContain(otherConversationImage._id.toString());

    const secondPage = await bob.agent
      .get(mediaPath)
      .query({ limit: 10, before: firstPage.body.nextCursor as string })
      .expect(200);
    const thirdPage = await alice.agent
      .get(mediaPath)
      .query({ limit: 10, before: secondPage.body.nextCursor as string })
      .expect(200);
    const listedIds = [
      ...firstPage.body.messages.map((message: { id: string }) => message.id),
      ...secondPage.body.messages.map((message: { id: string }) => message.id),
      ...thirdPage.body.messages.map((message: { id: string }) => message.id),
    ];
    expect(secondPage.body.messages).toHaveLength(10);
    expect(thirdPage.body.messages).toHaveLength(5);
    expect(thirdPage.body.nextCursor).toBeNull();
    expect(new Set(listedIds).size).toBe(25);
    expect(listedIds).not.toContain(deletedImage._id.toString());
  });

  it("updates only the authenticated user's display name, bio, and optional photo atomically", async () => {
    const alice = await createFixtureAccount("Profile Alice", "profile-alice@example.com");
    const bob = await createFixtureAccount("Profile Bob", "profile-bob@example.com");
    const profilePath = "/api/v1/auth/me/profile";
    const unauthorizedAgent = request.agent(baseUrl);
    const unauthorizedCsrf = await unauthorizedAgent.get("/api/v1/auth/csrf").expect(200);

    await unauthorizedAgent
      .put(profilePath)
      .set("x-csrf-token", unauthorizedCsrf.body.token as string)
      .field("displayName", "Intruder")
      .field("bio", "Not authorized")
      .expect(401);
    await alice.agent
      .put(profilePath)
      .field("displayName", "Missing CSRF")
      .field("bio", "")
      .expect(403);

    const updated = await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "  Alice Updated  ")
      .field("bio", "A short profile")
      .expect(200);
    expect(updated.body.user).toMatchObject({
      id: alice.userId,
      displayName: "Alice Updated",
      bio: "A short profile",
      email: "profile-alice@example.com",
    });
    expect(updated.body.user).not.toHaveProperty("passwordHash");
    expect((await User.findById(alice.userId).select("+displayNameSearch").lean())?.displayNameSearch)
      .toBe("alice updated");

    await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "   ")
      .field("bio", "")
      .expect(400);
    await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "x".repeat(65))
      .field("bio", "")
      .expect(400);
    await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "Alice Updated")
      .field("bio", "x".repeat(161))
      .expect(400);

    await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "Attempted account switch")
      .field("bio", "")
      .field("userId", bob.userId)
      .expect(400);
    expect((await User.findById(bob.userId).lean())?.displayName).toBe("Profile Bob");
    expect((await alice.agent.get("/api/v1/auth/me").expect(200)).body.user.displayName)
      .toBe("Alice Updated");

    const maximumBio = "b".repeat(160);
    const bioAtLimit = await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "Alice Updated")
      .field("bio", maximumBio)
      .expect(200);
    expect(bioAtLimit.body.user.bio).toBe(maximumBio);
    const clearedBio = await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "Alice Updated")
      .field("bio", "")
      .expect(200);
    expect(clearedBio.body.user.bio).toBe("");

    const jpeg = await sharp({ create: { width: 64, height: 96, channels: 3, background: "#2288cc" } })
      .jpeg()
      .toBuffer();
    const combinedUpdate = await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "Photo and text")
      .field("bio", "Saved together")
      .attach("avatar", jpeg, { filename: "profile.jpg", contentType: "image/jpeg" })
      .expect(200);
    const photoUser = await User.findById(alice.userId).select("+avatarKey").exec();
    expect(combinedUpdate.body.user).toMatchObject({
      displayName: "Photo and text",
      bio: "Saved together",
    });
    expect(combinedUpdate.body.user.avatarUrl).toBeTruthy();
    expect(photoUser?.avatarKey).toBeTruthy();

    const failedCombinedUpdate = await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "Must not partially save")
      .field("bio", "Must not partially save")
      .attach("avatar", Buffer.from("not an image"), { filename: "invalid.png", contentType: "image/png" })
      .expect(415);
    expect(failedCombinedUpdate.body.error.code).toBe("AVATAR_UNSUPPORTED");
    const unchangedProfile = await alice.agent.get("/api/v1/auth/me").expect(200);
    expect(unchangedProfile.body.user).toMatchObject({
      displayName: "Photo and text",
      bio: "Saved together",
      avatarUrl: combinedUpdate.body.user.avatarUrl,
    });

    const removed = await alice.agent
      .put(profilePath)
      .set("x-csrf-token", alice.csrfToken)
      .field("displayName", "Photo removed")
      .field("bio", "")
      .field("removeAvatar", "true")
      .expect(200);
    expect(removed.body.user).toMatchObject({
      displayName: "Photo removed",
      bio: "",
      avatarUrl: null,
    });
    expect(existsSync(join(avatarStorageRoot, photoUser!.avatarKey!))).toBe(false);
  });

  it("validates, persists, serves, replaces, and removes private profile photos", async () => {
    const alice = await registerAccount("Avatar Alice", "avatar-alice@example.com");
    const bob = await registerAccount("Avatar Bob", "avatar-bob@example.com");
    const avatarPath = `/api/v1/users/${alice.userId}/avatar`;
    await User.updateOne(
      { _id: alice.userId },
      { $unset: { avatarKey: "", avatarVersion: "" } },
    );

    await request(baseUrl).get(`${avatarPath}?v=1`).expect(401);
    const unauthenticatedAgent = request.agent(baseUrl);
    const unauthenticatedCsrf = await unauthenticatedAgent.get("/api/v1/auth/csrf").expect(200);
    await unauthenticatedAgent
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", unauthenticatedCsrf.body.token as string)
      .attach("avatar", Buffer.from("bytes"), { filename: "photo.jpg", contentType: "image/jpeg" })
      .expect(401);
    await alice.agent
      .put("/api/v1/auth/me/avatar")
      .attach("avatar", Buffer.from("bad image"), { filename: "avatar.png", contentType: "image/png" })
      .expect(403);
    await alice.agent
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", alice.csrfToken)
      .attach("avatar", Buffer.from("not an image"), { filename: "photo.png", contentType: "image/png" })
      .expect(415);

    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await alice.agent
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", alice.csrfToken)
      .attach("avatar", pngSignature, { filename: "damaged.png", contentType: "image/png" })
      .expect(400);
    const tooWidePng = await sharp({
      create: { width: 10_001, height: 1, channels: 3, background: "#336699" },
    }).png().toBuffer();
    await alice.agent
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", alice.csrfToken)
      .attach("avatar", tooWidePng, { filename: "too-wide.png", contentType: "image/png" })
      .expect(413);
    await alice.agent
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", alice.csrfToken)
      .attach("avatar", Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: "large.jpg",
        contentType: "image/jpeg",
      })
      .expect(413);

    const jpeg = await sharp({ create: { width: 64, height: 96, channels: 3, background: "#2288cc" } })
      .jpeg()
      .toBuffer();
    const firstUpload = await alice.agent
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", alice.csrfToken)
      .attach("avatar", jpeg, { filename: "untrusted.png", contentType: "image/png" })
      .expect(200);
    expect(firstUpload.body.user.avatarUrl).toMatch(
      new RegExp(`^/api/v1/users/${alice.userId}/avatar\\?v=\\d+$`),
    );
    expect(firstUpload.body.user).not.toHaveProperty("avatarKey");
    expect(firstUpload.body.user).not.toHaveProperty("avatarVersion");

    const storedAfterFirstUpload = await User.findById(alice.userId)
      .select("+avatarKey +avatarVersion")
      .exec();
    expect(storedAfterFirstUpload?.avatarKey).toMatch(
      /^[0-9a-f-]{36}\.webp$/,
    );
    expect(existsSync(join(avatarStorageRoot, storedAfterFirstUpload!.avatarKey!))).toBe(true);

    const photoResponse = await bob.agent.get(firstUpload.body.user.avatarUrl as string).expect(200);
    expect(photoResponse.headers["content-type"]).toContain("image/webp");
    const photoMetadata = await sharp(photoResponse.body as Buffer).metadata();
    expect(photoMetadata).toMatchObject({ format: "webp", width: 512, height: 512 });
    await request(baseUrl).get(firstUpload.body.user.avatarUrl as string).expect(401);
    await bob.agent
      .put(`/api/v1/auth/me/avatar/${alice.userId}`)
      .set("x-csrf-token", bob.csrfToken)
      .attach("avatar", jpeg, { filename: "attack.jpg", contentType: "image/jpeg" })
      .expect(404);
    expect((await User.findById(alice.userId).select("+avatarKey").exec())?.avatarKey)
      .toBe(storedAfterFirstUpload?.avatarKey);

    await alice.agent.post("/api/v1/auth/logout").set("x-csrf-token", alice.csrfToken).expect(204);
    const restoredSession = request.agent(baseUrl);
    const loginCsrf = await restoredSession.get("/api/v1/auth/csrf").expect(200);
    await restoredSession
      .post("/api/v1/auth/login")
      .set("x-csrf-token", loginCsrf.body.token as string)
      .send({ email: "avatar-alice@example.com", password: "a-secure-test-password" })
      .expect(200);
    const restoredCsrf = await restoredSession.get("/api/v1/auth/csrf").expect(200);
    const restoredProfile = await restoredSession.get("/api/v1/auth/me").expect(200);
    expect(restoredProfile.body.user.avatarUrl).toBe(firstUpload.body.user.avatarUrl);

    const secondJpeg = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#22aa88" } })
      .jpeg()
      .toBuffer();
    const replacement = await restoredSession
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", restoredCsrf.body.token as string)
      .attach("avatar", secondJpeg, { filename: "second.jpg", contentType: "image/jpeg" })
      .expect(200);
    const replacedUser = await User.findById(alice.userId).select("+avatarKey +avatarVersion").exec();
    expect(replacement.body.user.avatarUrl).not.toBe(firstUpload.body.user.avatarUrl);
    expect(existsSync(join(avatarStorageRoot, storedAfterFirstUpload!.avatarKey!))).toBe(false);
    expect(existsSync(join(avatarStorageRoot, replacedUser!.avatarKey!))).toBe(true);
    await restoredSession.get(firstUpload.body.user.avatarUrl as string).expect(404);

    await restoredSession.delete("/api/v1/auth/me/avatar")
      .set("x-csrf-token", restoredCsrf.body.token as string)
      .expect(200)
      .expect(({ body }) => expect(body.user.avatarUrl).toBeNull());
    expect(existsSync(join(avatarStorageRoot, replacedUser!.avatarKey!))).toBe(false);

    const thirdUpload = await restoredSession
      .put("/api/v1/auth/me/avatar")
      .set("x-csrf-token", restoredCsrf.body.token as string)
      .attach("avatar", jpeg, { filename: "third.jpg", contentType: "image/jpeg" })
      .expect(200);
    const missingFileUser = await User.findById(alice.userId).select("+avatarKey").exec();
    await unlink(join(avatarStorageRoot, missingFileUser!.avatarKey!));
    await restoredSession.get(thirdUpload.body.user.avatarUrl as string).expect(404);
    await restoredSession.delete("/api/v1/auth/me/avatar")
      .set("x-csrf-token", restoredCsrf.body.token as string)
      .expect(200)
      .expect(({ body }) => expect(body.user.avatarUrl).toBeNull());
  });
});
