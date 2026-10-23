import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";

import { env } from "../config/env.js";
import { sessionMiddleware, sessionStore } from "../config/session.js";
import { Conversation } from "../models/conversation.js";
import { findConversationForMember } from "../services/conversations.js";
import { createPersistedMessage, serializeMessage, serializeMessageForDelivery } from "../services/messages.js";
import { socketJoinSchema, socketMessageSchema } from "../validators/messages.js";

type Ack = (
  result:
    | { ok: true; message?: ReturnType<typeof serializeMessage> }
    | { ok: false; error: { code: string; message: string } },
) => void;

let socketServer: Server | undefined;
const socketMessageWindows = new Map<string, { timestamps: number[]; lastUsed: number }>();
let lastWindowCleanup = 0;

export function attachSocketServer(server: HttpServer): Server {
  const io = new Server(server, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true },
    allowRequest: (request, callback) => {
      callback(null, request.headers.origin === env.CLIENT_ORIGIN);
    },
  });

  io.engine.use(sessionMiddleware);
  io.use(async (socket, next) => {
    try {
      const sessionData = await loadSession(socket.request.sessionID);
      if (!sessionData?.userId) {
        next(new Error("unauthorized"));
        return;
      }
      socket.data.userId = sessionData.userId;
      socket.data.sessionId = socket.request.sessionID;
      socket.data.sessionExpiresAt = sessionData.expiresAt;
      next();
    } catch (error) {
      console.error("Socket authentication lookup failed", error);
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`session:${socket.data.sessionId}`);
    socket.join(`user:${socket.data.userId}`);
    const expirationTimer = socket.data.sessionExpiresAt
      ? setTimeout(
          () => socket.disconnect(true),
          Math.max(0, socket.data.sessionExpiresAt - Date.now()),
        )
      : undefined;
    expirationTimer?.unref();
    socket.once("disconnect", () => {
      if (expirationTimer) clearTimeout(expirationTimer);
    });
    socket.on("conversation:join", (payload: unknown, acknowledge?: Ack) => {
      void (async () => {
        if (!(await isSessionActive(socket.data.sessionId, socket.data.userId))) {
          acknowledge?.({
            ok: false,
            error: { code: "UNAUTHENTICATED", message: "Authentication required" },
          });
          socket.disconnect(true);
          return;
        }
        const parsed = socketJoinSchema.safeParse(payload);
        if (!parsed.success) {
          acknowledge?.({ ok: false, error: { code: "INVALID_PAYLOAD", message: "Invalid request" } });
          return;
        }

        const conversation = await findConversationForMember(
          parsed.data.conversationId,
          socket.data.userId,
        );
        if (!conversation) {
          acknowledge?.({
            ok: false,
            error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" },
          });
          return;
        }

        await socket.join(`conversation:${parsed.data.conversationId}`);
        acknowledge?.({ ok: true });
      })().catch((error: unknown) => {
        console.error("Socket conversation join failed", error);
        acknowledge?.({ ok: false, error: { code: "INTERNAL_ERROR", message: "Request failed" } });
      });
    });

    socket.on("message:send", (payload: unknown, acknowledge?: Ack) => {
      void (async () => {
        if (!(await isSessionActive(socket.data.sessionId, socket.data.userId))) {
          acknowledge?.({
            ok: false,
            error: { code: "UNAUTHENTICATED", message: "Authentication required" },
          });
          socket.disconnect(true);
          return;
        }
        const parsed = socketMessageSchema.safeParse(payload);
        if (!parsed.success) {
          acknowledge?.({ ok: false, error: { code: "INVALID_PAYLOAD", message: "Invalid request" } });
          return;
        }
        if (!allowSocketMessage(socket.data.userId)) {
          acknowledge?.({
            ok: false,
            error: { code: "RATE_LIMITED", message: "Too many messages. Please slow down." },
          });
          return;
        }

        const message = await createPersistedMessage({
          conversationId: parsed.data.conversationId,
          senderId: socket.data.userId,
          text: parsed.data.text,
          idempotencyKey: parsed.data.clientId,
        });
        const serialized = await serializeMessageForDelivery(message);
        await publishMessage(serialized);
        acknowledge?.({ ok: true, message: serialized });
      })().catch((error: unknown) => {
        console.error(
          "Socket message send failed",
          error instanceof Error ? error.name : "UnknownError",
        );
        acknowledge?.({ ok: false, error: { code: "MESSAGE_FAILED", message: "Message could not be sent" } });
      });
    });
  });

  socketServer = io;
  return io;
}

export async function publishMessage(message: ReturnType<typeof serializeMessage>): Promise<void> {
  if (!socketServer) throw new Error("Socket server has not been initialized");
  const conversation = await Conversation.findById(message.conversationId)
    .select("kind participants")
    .lean();
  if (!conversation) return;
  if (conversation.kind === "group") {
    for (const userId of conversation.participants) {
      socketServer.to(`user:${userId.toString()}`).emit("message:new", message);
    }
    return;
  }
  socketServer.to(`conversation:${message.conversationId}`).emit("message:new", message);
}

export async function publishGroupUpdate(groupId: string): Promise<void> {
  if (!socketServer) return;
  const group = await Conversation.findOne({ _id: groupId, kind: "group", archivedAt: null })
    .select("participants")
    .lean();
  if (!group) return;
  for (const userId of group.participants) {
    socketServer.to(`user:${userId.toString()}`).emit("group:updated", { conversationId: groupId });
  }
}

export function revokeSessionConnections(sessionId: string): void {
  socketServer?.in(`session:${sessionId}`).disconnectSockets(true);
}

function loadSession(
  sessionId: string,
): Promise<{ userId?: string; expiresAt?: number } | null> {
  return new Promise((resolve, reject) => {
    sessionStore.get(sessionId, (error, value) => {
      if (error) {
        reject(error);
        return;
      }
      const sessionData = value ?? null;
      const expires = sessionData?.cookie?.expires;
      const expiresAt = expires ? new Date(expires).getTime() : undefined;
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        resolve(null);
        return;
      }
      resolve(sessionData ? { userId: sessionData.userId, expiresAt } : null);
    });
  });
}

async function isSessionActive(sessionId: string, userId: string): Promise<boolean> {
  const current = await loadSession(sessionId);
  return current?.userId === userId;
}

function allowSocketMessage(userId: string): boolean {
  const now = Date.now();
  if (now - lastWindowCleanup > 60_000) {
    for (const [id, window] of socketMessageWindows) {
      if (now - window.lastUsed > 120_000) socketMessageWindows.delete(id);
    }
    lastWindowCleanup = now;
  }

  const window = socketMessageWindows.get(userId) ?? { timestamps: [], lastUsed: now };
  window.timestamps = window.timestamps.filter((timestamp) => now - timestamp < 60_000);
  window.lastUsed = now;
  if (window.timestamps.length >= 60) {
    socketMessageWindows.set(userId, window);
    return false;
  }
  window.timestamps.push(now);
  socketMessageWindows.set(userId, window);
  return true;
}
