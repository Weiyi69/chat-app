import "express-session";
import type { Session, SessionData } from "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

declare module "http" {
  interface IncomingMessage {
    session: Session & Partial<SessionData>;
    sessionID: string;
  }
}
