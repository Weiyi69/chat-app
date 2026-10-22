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
import { avatarStorageRoot, imageStorageRoot } from "../src/config/env.js";
import { Conversation } from "../src/models/conversation.js";
import { Message } from "../src/models/message.js";
import { User } from "../src/models/user.js";
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
