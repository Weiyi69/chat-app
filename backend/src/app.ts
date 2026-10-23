import cors from "cors";
import express from "express";
import helmet from "helmet";
import { csrfSync } from "csrf-sync";

import { env } from "./config/env.js";
import { sessionMiddleware } from "./config/session.js";
import { authRouter } from "./routes/auth.js";
import { conversationsRouter } from "./routes/conversations.js";
import { messagesRouter } from "./routes/messages.js";
import { usersRouter } from "./routes/users.js";
import { ChatRequestError } from "./services/messages.js";

export const app = express();

app.disable("x-powered-by");
if (env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}
const imageSources = ["'self'", "data:", "blob:"];
if (env.IMAGE_STORAGE_DRIVER === "s3") {
  imageSources.push(
    env.S3_ENDPOINT
      ? new URL(env.S3_ENDPOINT).origin
      : `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`,
  );
}
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        imgSrc: imageSources,
      },
    },
  }),
);
app.use(
  cors({
    origin: env.CLIENT_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json({ limit: "32kb" }));

app.use(sessionMiddleware);

const { generateToken, csrfSynchronisedProtection } = csrfSync({
  errorConfig: {
    statusCode: 403,
    message: "Invalid CSRF token",
    code: "CSRF_INVALID",
  },
});

app.get("/api/v1/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.get("/api/v1/limits", (_request, response) => {
  response.status(200).json({
    image: {
      maxUploadBytes: env.IMAGE_MAX_UPLOAD_BYTES,
      contentTypes: ["image/jpeg", "image/png", "image/webp"],
    },
    attachment: {
      maxUploadBytes: env.ATTACHMENT_MAX_UPLOAD_BYTES,
      contentTypes: [
        "application/pdf",
        "text/plain",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
      ],
      extensions: ["pdf", "txt", "docx", "xlsx", "csv"],
    },
    avatar: {
      maxUploadBytes: env.AVATAR_MAX_UPLOAD_BYTES,
      contentTypes: ["image/jpeg", "image/png", "image/webp"],
    },
  });
});

app.get("/api/v1/auth/csrf", (request, response) => {
  response.status(200).json({ token: generateToken(request) });
});

app.use("/api/v1", csrfSynchronisedProtection);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/users", usersRouter);
app.use("/api/v1/conversations", conversationsRouter);
app.use("/api/v1/conversations", messagesRouter);

app.use((_request, response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
});

app.use(
  (error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "MulterError" &&
      "code" in error
    ) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      const isAttachmentUpload = "field" in error && error.field === "attachment";
      response.status(tooLarge ? 413 : 400).json({
        error: {
          code: tooLarge
            ? isAttachmentUpload ? "ATTACHMENT_TOO_LARGE" : "IMAGE_TOO_LARGE"
            : "INVALID_UPLOAD",
          message: tooLarge
            ? isAttachmentUpload
              ? "File exceeds the configured attachment size limit."
              : "Image exceeds the configured upload size limit."
            : isAttachmentUpload
              ? "Choose one supported file and retry."
              : "Choose one supported image and retry.",
        },
      });
      return;
    }
    if (typeof error === "object" && error !== null && "name" in error && error.name === "ZodError") {
      response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Request data is invalid" },
      });
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "CSRF_INVALID") {
      response.status(403).json({ error: { code: "CSRF_INVALID", message: "Invalid CSRF token" } });
      return;
    }
    if (error instanceof ChatRequestError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    console.error(
      "Unhandled request error",
      error instanceof Error ? error.name : "UnknownError",
    );
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  },
);
