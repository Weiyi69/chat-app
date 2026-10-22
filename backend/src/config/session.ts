import MongoStore from "connect-mongo";
import session from "express-session";

import { env } from "./env.js";

export const sessionStore =
  env.NODE_ENV === "test"
    ? new session.MemoryStore()
    : MongoStore.create({
        mongoUrl: env.MONGODB_URI,
        collectionName: "sessions",
        ttl: 60 * 60 * 24 * 7,
      });

export const sessionMiddleware = session({
  name: env.NODE_ENV === "production" ? "__Host-converse.sid" : "converse.sid",
  secret: env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});
