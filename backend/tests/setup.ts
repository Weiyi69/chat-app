import { tmpdir } from "node:os";
import { resolve } from "node:path";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/converse-test";
process.env.SESSION_SECRET ??= "test-session-secret-value-with-at-least-32-characters";
process.env.CLIENT_ORIGIN ??= "http://localhost:5173";
process.env.IMAGE_STORAGE_DRIVER = "local";
process.env.IMAGE_MAX_UPLOAD_BYTES = String(5 * 1024 * 1024);
process.env.IMAGE_SIGNED_URL_TTL_SECONDS = "300";
process.env.IMAGE_LOCAL_STORAGE_DIR = resolve(tmpdir(), `converse-test-images-${process.pid}`);
process.env.AVATAR_STORAGE_DIR = resolve(tmpdir(), `converse-test-avatars-${process.pid}`);
process.env.AVATAR_MAX_UPLOAD_BYTES = String(5 * 1024 * 1024);
