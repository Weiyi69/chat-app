import { createServer } from "node:http";
import mongoose from "mongoose";

import { app } from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { Conversation } from "./models/conversation.js";
import { Message } from "./models/message.js";
import { User } from "./models/user.js";
import { cleanupOrphanedImages } from "./services/image-messages.js";
import { cleanupOrphanedAvatars } from "./services/avatars.js";
import { attachSocketServer } from "./sockets/realtime.js";

try {
  await connectDatabase();
  await Promise.all([User.init(), Conversation.init(), Message.init()]);
  await cleanupOrphanedAvatars();
} catch (error) {
  console.error(
    "Backend startup failed while connecting to or initializing MongoDB",
    error instanceof Error ? error.name : "UnknownError",
  );
  process.exit(1);
}

const server = createServer(app);
const io = attachSocketServer(server);

const cleanupTimer = setInterval(() => {
  void cleanupOrphanedImages().catch((error: unknown) => {
    console.error(
      "Image orphan cleanup failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  });
}, 6 * 60 * 60 * 1000);
cleanupTimer.unref();
void cleanupOrphanedImages().catch((error: unknown) => {
  console.error(
    "Image orphan cleanup failed",
    error instanceof Error ? error.name : "UnknownError",
  );
});

server.listen(env.PORT, () => {
  console.info(`API listening on port ${env.PORT}`);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanupTimer);
    io.close(() => {
      void mongoose.disconnect().then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          console.error(
            "Database shutdown failed",
            error instanceof Error ? error.name : "UnknownError",
          );
          process.exitCode = 1;
        },
      );
    });
  });
}
