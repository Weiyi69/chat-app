# Converse

Converse is a private messaging app built with React, TypeScript, Vite, Tailwind CSS, Express, Socket.IO, and MongoDB/Mongoose. It supports account registration and login, editable display names and bios, local profile and group photos, user discovery, direct and group conversations, bounded message history, and persisted real-time text and image messaging.

This project is not end-to-end encrypted. Do not use it to send information that requires end-to-end confidentiality.

## Requirements

- Node.js 20.19+ (Node 24 is used in CI) and npm.
- A MongoDB Atlas deployment or another reachable MongoDB instance.
- Atlas network access configured for the developer's current IP address, and a database user with access only to the application database.

## Local setup

1. Install dependencies from the repository root:

   ```powershell
   npm install
   ```

2. Create a local environment file and set its values:

   ```powershell
   Copy-Item .env.example .env
   ```

   For a non-default API origin, also copy `frontend/.env.example` to `frontend/.env` and set `VITE_API_BASE_URL`. This is public frontend configuration, not a secret.

   Required configuration:

   | Variable | Purpose |
   | --- | --- |
   | `NODE_ENV` | `development`, `test`, or `production` |
   | `PORT` | Backend HTTP/Socket.IO port; defaults to `4000` |
   | `MONGODB_URI` | MongoDB connection URI for the application database |
   | `SESSION_SECRET` | Random secret of at least 32 characters for signing session cookies |
   | `CLIENT_ORIGIN` | Exact frontend origin allowed by HTTP CORS and Socket.IO; defaults to `http://localhost:5173` |
   | `IMAGE_STORAGE_DRIVER` | `local` for development, or `s3` for a private S3-compatible object store; production requires `s3` |
   | `IMAGE_MAX_UPLOAD_BYTES` | Maximum image size in bytes; defaults to `5242880` (5 MiB), configurable from 1 KiB to 20 MiB |
   | `IMAGE_LOCAL_STORAGE_DIR` | Local development image directory; defaults to `.data/images` and is Git-ignored |
   | `IMAGE_SIGNED_URL_TTL_SECONDS` | Lifetime of private S3 read URLs; defaults to 300 seconds and is limited to 30–900 seconds |
   | `AVATAR_MAX_UPLOAD_BYTES` | Maximum profile-photo upload size; defaults to `5242880` (5 MiB), configurable from 1 KiB to 20 MiB |
   | `AVATAR_STORAGE_DIR` | Local profile-photo directory; defaults to `backend/uploads/avatars` and is Git-ignored |
   | `S3_BUCKET`, `S3_REGION` | Required when `IMAGE_STORAGE_DRIVER=s3` |
   | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Backend-only credentials for the private object store; use a narrowly scoped service identity |
   | `S3_ENDPOINT` | Optional S3-compatible endpoint, such as an R2 account endpoint; omit for AWS S3 |
   | `VITE_API_BASE_URL` | Optional frontend build-time API origin; defaults to `http://localhost:4000` |

   Generate a suitable local session secret in PowerShell:

   ```powershell
   [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
   ```

   Keep `.env` private. It is excluded from Git. `.env.example` contains placeholders only. Never put the database URI or session secret in a `VITE_` variable.

3. In MongoDB Atlas, create a database user with the minimum read/write permissions required for the application database, allow only trusted client IPs in Network Access, and use the TLS-enabled connection string Atlas provides. URL-encode special characters in the database username or password before placing them in the URI.

4. For local development, keep `IMAGE_STORAGE_DRIVER=local`. Message images are stored outside MongoDB under `.data/images`; profile photos are stored separately under `backend/uploads/avatars`. Both runtime directories are excluded from Git. Message images require conversation membership, while profile-photo reads require a signed-in Converse account. Local filesystem storage is for development and single-machine use, not production deployment or multi-instance hosting.

5. Start the backend and frontend together:

   ```powershell
   npm run dev
   ```

   The API listens on `http://localhost:4000`; Vite serves the UI at `http://localhost:5173`. The backend verifies its environment, connects to MongoDB, and initializes required unique indexes before accepting requests. Open the frontend URL in a browser to register.

## Commands

Run from the repository root:

| Command | Description |
| --- | --- |
| `npm run dev` | Start the backend and frontend development servers |
| `npm run lint` | Lint TypeScript and JavaScript source |
| `npm run typecheck` | Type-check both workspaces |
| `npm test` | Run backend integration/boundary tests and frontend tests |
| `npm run build` | Create production builds for both workspaces |
| `npm audit` | Audit installed dependencies |

The backend integration tests use `mongodb-memory-server`; the first test run may download a MongoDB test binary. They do not use Atlas credentials or application secrets.

## Architecture and behavior

- `frontend/` contains the React application, routes, forms, API client, query cache, and Socket.IO client.
- `backend/` contains the versioned REST API, Mongoose models, validation, authorization, session configuration, messaging service, and Socket.IO handlers.
- REST is used for account operations, discovery, conversation creation/listing, message history, and the UI's message submissions.
- Direct and group conversations share the `Conversation` and `Message` models. Older conversation records without a `kind` remain direct conversations; no data migration or reset is required. Group records have a unique `group:<conversation-id>` pair key, a name, creator, optional photo reference, member roles/join times, and optional archival time.
- Group creation requires a name and at least two other registered members. The creator starts as an admin. Admins can rename groups and add/remove members; users can leave. If the last admin leaves, the longest-standing remaining member is promoted. A group is archived (messages retained) when its final member leaves.
- Group history, text/image sending, and image reads use the same membership checks as direct conversations. Removing or leaving a group removes the user from its active participant list, which immediately denies later HTTP history/send/image requests and socket joins. Group message broadcasts target only the current member accounts, not stale conversation-room memberships.
- The frontend obtains a synchronizer CSRF token from `GET /api/v1/auth/csrf` and sends it in `x-csrf-token` for state-changing HTTP requests.
- Session IDs are server-managed in MongoDB, not browser storage. Cookies are HttpOnly and SameSite=Lax; they are Secure in production. Login and registration renew the session; logout invalidates it and disconnects associated sockets.
- Message REST and Socket.IO submissions share `createPersistedMessage`. The backend validates membership, stores the message, updates the conversation preview, and only then broadcasts `message:new`. Message retries use a UUID idempotency key; reusing a key with different content is rejected.
- Image messages are uploaded as multipart data through the authenticated, CSRF-protected REST API. The backend ignores client filenames and MIME claims, verifies JPEG/PNG/WebP signatures, decodes and normalizes the image with Sharp, strips metadata, and enforces byte, dimension, and pixel limits before storage. Captions are optional. The image reference and validated metadata share the same `Message` record and chronological pagination as text.
- A private storage adapter writes to `.data/images` in development or to private S3-compatible storage when enabled. In S3 mode, an authorized image request first verifies the current session, conversation membership, and message reference, then returns a short-lived signed read URL. Local image bytes are returned only after the same checks. Storage keys are generated by the server and never exposed in message JSON.
- Profile photos use a separate local-only store at `backend/uploads/avatars` by default. Authenticated users may view another signed-in user's avatar; upload and removal always derive the account from the current session and require CSRF protection. The backend validates JPEG/PNG/WebP signatures, decodes within dimension and 40-megapixel limits, strips metadata, center-crops to a 512×512 WebP, and stores a random server-generated filename. MongoDB stores only this generated key and a cache version; API responses expose only an authenticated versioned URL. `AVATAR_MAX_UPLOAD_BYTES` defaults to 5 MiB. The app creates the directory on first upload and cleans unreferenced generated avatar files during startup.
- Image objects use a generated `converse/` storage prefix and are uploaded before message persistence; the object is removed if persistence fails. A cleanup task scans objects older than 24 hours every six hours and deletes only keys with no matching image message. S3 mode therefore requires narrowly scoped bucket listing and object permissions for this prefix.
- Socket connections use the same session middleware as HTTP. Connections are checked against the session store, expire with their session, and are disconnected on logout. Clients can join a conversation room only after server-side membership verification. Group membership-update notices and group messages are sent only to authenticated sockets belonging to current members.
- Event contracts:
  - `conversation:join`: `{ conversationId }`; acknowledgement indicates success or a generic access error.
  - `message:send`: `{ conversationId, text, clientId }`; the acknowledgement includes the persisted message or a safe error.
  - `message:new`: server-emitted persisted message with `id`, `conversationId`, `senderId`, `type`, `text`, `createdAt`, and sender profile details; image messages also include validated image metadata and a membership-authorized image route.
  - `group:updated`: `{ conversationId }`; sent to current group members after group details, membership, or photo changes.
- `GET /limits` returns the configured image byte limit and supported content types so the frontend can validate selections before upload; the server remains authoritative.
- Image REST routes:
  - `POST /conversations/:conversationId/messages/image` accepts multipart fields `image`, optional `caption`, and UUID `clientId`. It uses the same persisted-message event only after storage and database persistence succeed.
  - `GET /conversations/:conversationId/messages/:messageId/image` verifies conversation membership and that the message references an image before returning local bytes or a private S3 signed-URL response. Signed URL lifetime is configurable within the documented bound.
- Conversation pairs are canonicalized by sorting their two user IDs into a `pairKey` protected by a unique MongoDB index. Message idempotency is enforced by a unique `(conversationId, senderId, idempotencyKey)` index. Startup waits for these indexes.
- Message history is cursor-paginated and capped at 50 per request. Search results and conversation listings are bounded; search results expose only a user's ID, display name, and optional avatar reference.
- User discovery uses prefix matching on a normalized display-name field and normalized email, with bounded, rate-limited results.
- Message content is rendered as text. No unread counts are claimed because reliable read tracking is not part of this MVP.

## API overview

All routes are under `/api/v1`:

- `GET /health`
- `GET /auth/csrf`
- `GET /limits`
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `PUT /auth/me/avatar` (multipart field `avatar`), `DELETE /auth/me/avatar`
- `GET /users?search=...`
- `GET /users/:userId/avatar?v=:version` (authenticated)
- `GET /conversations`, `POST /conversations`
- `POST /conversations/groups`, `GET /conversations/groups/:groupId`
- `GET /conversations/groups/:groupId/photo` (current members), `PUT` and `DELETE /conversations/groups/:groupId/photo` (admins)
- `PATCH /conversations/groups/:groupId`, `POST /conversations/groups/:groupId/members`
- `DELETE /conversations/groups/:groupId/members/:memberId`, `POST /conversations/groups/:groupId/leave`
- `GET /conversations/:conversationId/messages?limit=...&before=...`
- `POST /conversations/:conversationId/messages`

Request boundaries are validated with Zod. Authentication, user search, conversation creation, and REST message submission have rate limits. Private resources return no conversation or message data to non-members.

## Local profile and group-photo storage

- Select **Edit profile photo** from the account menu to preview, replace, save, or remove the signed-in user's photo. Images are not stored in `frontend/public`; the app serves them through the authenticated API.
- Group admins can preview, replace, or remove a group photo in **Group details**. Active group members only can retrieve a group's photo; changes are announced through the existing `group:updated` event.
- The default Windows development location is `<repository>\backend\uploads\avatars`. Set `AVATAR_STORAGE_DIR` in the root `.env` to an absolute path if you want the avatar files elsewhere. The directory is created automatically when the first photo is saved.
- JPEG, PNG, and WebP are accepted for profile and group photos. The default input limit is 5 MiB; configure `AVATAR_MAX_UPLOAD_BYTES` in the root `.env` (allowed range 1 KiB–20 MiB). Images are normalized to 512×512 WebP, and original filenames and metadata are not retained.
- If an avatar fails to load, confirm the backend is running, the account is signed in, and the avatar file exists under the configured directory. Missing or stale file references return a safe 404; removing the photo and uploading it again repairs the account. On Windows, make sure the account running Node can create and write files in the directory.
- Back up the MongoDB database and the complete avatar directory together. The database references generated filenames in that folder; restoring only one side can leave users or groups with missing photos or unreferenced files. Restore both from a consistent backup. Startup cleanup removes only generated WebP files not referenced by a user or group.

## Production deployment

- Deploy the frontend as static assets and the backend on a Node.js host that supports persistent WebSocket connections.
- Set `NODE_ENV=production`, a strong secret from a secret manager, the production MongoDB URI, the correct exact `CLIENT_ORIGIN`, and a deployment port. Do not commit production secrets.
- Set `IMAGE_STORAGE_DRIVER=s3`; startup rejects local image storage in production. Configure `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` in the backend secret manager. For R2 or another compatible service, set `S3_ENDPOINT` as well (for R2, use the account endpoint and region `auto`). Never use a `VITE_` variable for storage credentials. No object-store account is provisioned by this project.
- Keep the bucket private and block public access. Grant the backend service identity only `PutObject`, `GetObject`, and `DeleteObject` on `arn:aws:s3:::<bucket>/converse/*`, plus `ListBucket` on the bucket restricted by the `s3:prefix` condition to `converse/*`; do not grant public ACL or anonymous access. The periodic orphan cleanup needs `ListBucket` and `DeleteObject`. Signed read URLs expire after `IMAGE_SIGNED_URL_TTL_SECONDS` (default five minutes; maximum fifteen minutes). A signed URL is a temporary bearer capability: do not log or share it. The frontend first authorizes through the API, then loads the signed URL as an image; bucket-wide public reads are not required.
- The default per-image limit is 5 MiB; `IMAGE_MAX_UPLOAD_BYTES` can be raised up to 20 MiB. The server also enforces maximum dimensions of 10,000 pixels per side and 40 megapixels total. Only JPEG, PNG, and WebP are accepted. Size limits apply to both input and normalized output.
- Set the frontend build's `VITE_API_BASE_URL` to the public API origin.
- Serve both origins over HTTPS. Use a frontend and API origin compatible with SameSite=Lax cookies (typically subdomains of the same site); configure the exact frontend origin in `CLIENT_ORIGIN`.
- Configure the reverse proxy to preserve WebSocket upgrade headers and forward HTTPS state correctly. The backend trusts one proxy hop in production; adjust that only to match the verified deployment topology.
- Restrict Atlas Network Access and database user permissions. Enable monitoring and backups according to the deployment's recovery requirements.
- This MVP runs a single backend instance. Multi-instance Socket.IO delivery requires a shared adapter such as Redis and coordinated deployment/session considerations, intentionally deferred.

## Current limitations and next steps

Typing indicators, presence, read receipts, push notifications, message editing/deletion, and end-to-end encryption are not implemented. Local filesystem message-image storage is for development only; production deployments must configure private object storage for message images. Profile and group photo storage is local-only and is not a production multi-instance storage system. The conversation list is capped at 50 entries.

End-to-end encryption needs a separate threat model and key-management design and should not be bolted onto the current server-readable message model.
