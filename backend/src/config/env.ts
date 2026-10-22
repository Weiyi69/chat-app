import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repositoryEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
config({ path: repositoryEnvPath });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(?:\+srv)?:\/\//, "MONGODB_URI must be a MongoDB connection URI")
    .refine((uri) => !uri.includes("<") && !uri.includes(">"), "MONGODB_URI must not contain placeholders"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters")
    .refine((secret) => !secret.toLowerCase().includes("replace-with"), "SESSION_SECRET must be replaced"),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:5173"),
  IMAGE_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  IMAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  IMAGE_LOCAL_STORAGE_DIR: z.string().min(1).default(".data/images"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  IMAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  AVATAR_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  AVATAR_STORAGE_DIR: z.string().min(1).default("backend/uploads/avatars"),
}).superRefine((configuration, context) => {
  if (new URL(configuration.CLIENT_ORIGIN).origin !== configuration.CLIENT_ORIGIN) {
    context.addIssue({
      code: "custom",
      path: ["CLIENT_ORIGIN"],
      message: "CLIENT_ORIGIN must not include a path or trailing slash",
    });
  }
  if (configuration.NODE_ENV === "production" && new URL(configuration.CLIENT_ORIGIN).protocol !== "https:") {
    context.addIssue({
      code: "custom",
      path: ["CLIENT_ORIGIN"],
      message: "CLIENT_ORIGIN must use HTTPS in production",
    });
  }
  if (configuration.NODE_ENV === "production" && configuration.IMAGE_STORAGE_DRIVER !== "s3") {
    context.addIssue({
      code: "custom",
      path: ["IMAGE_STORAGE_DRIVER"],
      message: "Production requires private S3-compatible image storage",
    });
  }
  if (configuration.IMAGE_STORAGE_DRIVER === "s3") {
    for (const field of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!configuration[field]?.trim()) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when IMAGE_STORAGE_DRIVER=s3`,
        });
      }
    }
  }
  if (configuration.S3_ENDPOINT) {
    const endpoint = new URL(configuration.S3_ENDPOINT);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      context.addIssue({
        code: "custom",
        path: ["S3_ENDPOINT"],
        message: "S3_ENDPOINT must be an HTTP(S) endpoint without embedded credentials",
      });
    }
    if (configuration.NODE_ENV === "production" && endpoint.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["S3_ENDPOINT"],
        message: "Production S3_ENDPOINT must use HTTPS",
      });
    }
  }
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  const invalidFields = [...new Set(parsedEnv.error.issues.map((issue) => issue.path[0]))]
    .map(String)
    .join(", ");
  throw new Error(`Invalid environment configuration. Check: ${invalidFields}`);
}

export const env = parsedEnv.data;
export const imageStorageRoot = resolve(repositoryRoot, env.IMAGE_LOCAL_STORAGE_DIR);
export const avatarStorageRoot = resolve(repositoryRoot, env.AVATAR_STORAGE_DIR);
