import type {
  Conversation,
  GroupConversation,
  Message,
  MessagePage,
  MessageReader,
  ReadPosition,
  SearchUser,
  User,
} from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

let csrfToken: string | undefined;

function parseError(response: Response): Promise<ApiError> {
  return response.json().then(
    (payload: { error?: { code?: string; message?: string } }) =>
      new ApiError(
        payload.error?.message ?? "Request failed",
        response.status,
        payload.error?.code ?? "REQUEST_FAILED",
      ),
    () => new ApiError("Request failed", response.status, "REQUEST_FAILED"),
  );
}

async function ensureCsrfToken(): Promise<string> {
  if (!csrfToken) {
    const response = await fetch(`${API_BASE}/api/v1/auth/csrf`, { credentials: "include" });
    if (!response.ok) throw new ApiError("Could not start a secure session", response.status, "CSRF");
    const result = (await response.json()) as { token: string };
    csrfToken = result.token;
  }
  return csrfToken;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-csrf-token", await ensureCsrfToken());
  }

  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    const error = await parseError(response);
    if (response.status === 403 && error.code === "CSRF_INVALID") csrfToken = undefined;
    throw error;
  }
  return (await response.json()) as T;
}

function uploadImage(
  conversationId: string,
  file: File,
  caption: string,
  clientId: string,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
  replyToMessageId?: string,
): Promise<Message> {
  return ensureCsrfToken().then((token) =>
    new Promise<Message>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("caption", caption);
      form.append("clientId", clientId);
      if (replyToMessageId) form.append("replyToMessageId", replyToMessageId);
      form.append("image", file);
      xhr.open(
        "POST",
        `${API_BASE}/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/image`,
      );
      xhr.withCredentials = true;
      xhr.setRequestHeader("x-csrf-token", token);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
      const abortUpload = () => xhr.abort();
      const removeAbortListener = () => signal.removeEventListener("abort", abortUpload);
      xhr.addEventListener("load", () => {
        removeAbortListener();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve((JSON.parse(xhr.responseText) as { message: Message }).message);
          } catch {
            reject(new ApiError("The server returned an invalid response", xhr.status, "INVALID_RESPONSE"));
          }
          return;
        }
        let payload: { error?: { code?: string; message?: string } } = {};
        try {
          payload = JSON.parse(xhr.responseText) as typeof payload;
        } catch {
          // Use the generic request error below when the server did not return JSON.
        }
        if (xhr.status === 403 && payload.error?.code === "CSRF_INVALID") csrfToken = undefined;
        reject(
          new ApiError(
            payload.error?.message ?? "Image could not be sent",
            xhr.status,
            payload.error?.code ?? "REQUEST_FAILED",
          ),
        );
      });
      xhr.addEventListener("error", () => {
        removeAbortListener();
        reject(new ApiError("Network error while uploading image", 0, "NETWORK_ERROR"));
      });
      xhr.addEventListener("abort", () => {
        removeAbortListener();
        reject(new DOMException("Upload cancelled", "AbortError"));
      });
      if (signal.aborted) {
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      signal.addEventListener("abort", abortUpload, { once: true });
      xhr.send(form);
    }),
  );
}

function uploadGroupPhoto(
  groupId: string,
  file: File,
  onProgress: (progress: number) => void,
): Promise<GroupConversation> {
  return ensureCsrfToken().then((token) =>
    new Promise<GroupConversation>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("photo", file);
      xhr.open(
        "PUT",
        `${API_BASE}/api/v1/conversations/groups/${encodeURIComponent(groupId)}/photo`,
      );
      xhr.withCredentials = true;
      xhr.setRequestHeader("x-csrf-token", token);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve((JSON.parse(xhr.responseText) as { conversation: GroupConversation }).conversation);
          } catch {
            reject(new ApiError("The server returned an invalid response", xhr.status, "INVALID_RESPONSE"));
          }
          return;
        }
        let payload: { error?: { code?: string; message?: string } } = {};
        try {
          payload = JSON.parse(xhr.responseText) as typeof payload;
        } catch {
          // Use the generic request error below when the server did not return JSON.
        }
        if (xhr.status === 403 && payload.error?.code === "CSRF_INVALID") csrfToken = undefined;
        reject(
          new ApiError(
            payload.error?.message ?? "Group photo could not be saved",
            xhr.status,
            payload.error?.code ?? "REQUEST_FAILED",
          ),
        );
      });
      xhr.addEventListener("error", () => {
        reject(new ApiError("Network error while uploading group photo", 0, "NETWORK_ERROR"));
      });
      xhr.send(form);
    }),
  );
}

async function loadPrivateImage(
  path: string,
  signal: AbortSignal,
): Promise<{ url: string; revoke: () => void }> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include", signal });
  if (!response.ok) throw await parseError(response);
  if (response.headers.get("content-type")?.includes("application/json")) {
    const payload = (await response.json()) as { url?: string };
    if (!payload.url) throw new ApiError("Image could not be loaded", response.status, "INVALID_RESPONSE");
    return { url: payload.url, revoke: () => undefined };
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  return { url: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) };
}

export const authApi = {
  me: async () => (await apiRequest<{ user: User }>("/auth/me")).user,
  avatarLimits: async () =>
    (await apiRequest<{ avatar: { maxUploadBytes: number; contentTypes: string[] } }>("/limits")).avatar,
  uploadAvatar: async (file: File, onProgress: (progress: number) => void): Promise<User> => {
    const token = await ensureCsrfToken();
    return new Promise<User>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("avatar", file);
      xhr.open("PUT", `${API_BASE}/api/v1/auth/me/avatar`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("x-csrf-token", token);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve((JSON.parse(xhr.responseText) as { user: User }).user);
          } catch {
            reject(new ApiError("The server returned an invalid response", xhr.status, "INVALID_RESPONSE"));
          }
          return;
        }
        let payload: { error?: { code?: string; message?: string } } = {};
        try {
          payload = JSON.parse(xhr.responseText) as typeof payload;
        } catch {
          // Use the generic request error below when the server did not return JSON.
        }
        if (xhr.status === 403 && payload.error?.code === "CSRF_INVALID") csrfToken = undefined;
        reject(
          new ApiError(
            payload.error?.message ?? "Profile photo could not be saved",
            xhr.status,
            payload.error?.code ?? "REQUEST_FAILED",
          ),
        );
      });
      xhr.addEventListener("error", () => {
        reject(new ApiError("Network error while uploading profile photo", 0, "NETWORK_ERROR"));
      });
      xhr.send(form);
    });
  },
  removeAvatar: async () =>
    (await apiRequest<{ user: User }>("/auth/me/avatar", { method: "DELETE" })).user,
  login: async (data: { email: string; password: string }) => {
    const result = await apiRequest<{ user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
    csrfToken = undefined;
    return result.user;
  },
  register: async (data: { displayName: string; email: string; password: string }) => {
    const result = await apiRequest<{ user: User }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
    csrfToken = undefined;
    return result.user;
  },
  logout: async () => {
    await apiRequest<void>("/auth/logout", { method: "POST" });
    csrfToken = undefined;
  },
};

export const chatApi = {
  imageLimits: async () => (await apiRequest<{
    image: { maxUploadBytes: number; contentTypes: string[] };
  }>("/limits")).image,
  groupPhotoLimits: async () => (await apiRequest<{
    avatar: { maxUploadBytes: number; contentTypes: string[] };
  }>("/limits")).avatar,
  conversations: async () =>
    (await apiRequest<{ conversations: Conversation[] }>("/conversations")).conversations,
  searchUsers: (search: string, cursor?: string) => {
    const query = new URLSearchParams({ search, limit: "10" });
    if (cursor) query.set("cursor", cursor);
    return apiRequest<{ users: SearchUser[]; nextCursor: string | null }>(
      `/users?${query.toString()}`,
    );
  },
  createConversation: async (otherUserId: string) =>
    (await apiRequest<{ conversation: Conversation }>("/conversations", {
      method: "POST",
      body: JSON.stringify({ otherUserId }),
    })).conversation,
  createGroup: async (name: string, memberIds: string[]) =>
    (await apiRequest<{ conversation: GroupConversation }>("/conversations/groups", {
      method: "POST",
      body: JSON.stringify({ name, memberIds }),
    })).conversation,
  groupDetails: async (groupId: string) =>
    (await apiRequest<{ conversation: GroupConversation }>(
      `/conversations/groups/${encodeURIComponent(groupId)}`,
    )).conversation,
  uploadGroupPhoto,
  removeGroupPhoto: async (groupId: string) =>
    (await apiRequest<{ conversation: GroupConversation }>(
      `/conversations/groups/${encodeURIComponent(groupId)}/photo`,
      { method: "DELETE" },
    )).conversation,
  renameGroup: async (groupId: string, name: string) =>
    (await apiRequest<{ conversation: GroupConversation }>(
      `/conversations/groups/${encodeURIComponent(groupId)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    )).conversation,
  addGroupMembers: async (groupId: string, memberIds: string[]) =>
    (await apiRequest<{ conversation: GroupConversation }>(
      `/conversations/groups/${encodeURIComponent(groupId)}/members`,
      { method: "POST", body: JSON.stringify({ memberIds }) },
    )).conversation,
  removeGroupMember: async (groupId: string, memberId: string) =>
    (await apiRequest<{ conversation: GroupConversation }>(
      `/conversations/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}`,
      { method: "DELETE" },
    )).conversation,
  leaveGroup: (groupId: string) =>
    apiRequest<{ id: string; archived: boolean }>(
      `/conversations/groups/${encodeURIComponent(groupId)}/leave`,
      { method: "POST" },
    ),
  messages: (conversationId: string, before?: string) => {
    const query = new URLSearchParams({ limit: "40" });
    if (before) query.set("before", before);
    return apiRequest<MessagePage>(
      `/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`,
    );
  },
  receipts: async (conversationId: string) =>
    (await apiRequest<{ positions: ReadPosition[] }>(
      `/conversations/${encodeURIComponent(conversationId)}/receipts`,
    )).positions,
  messageReaders: async (conversationId: string, messageId: string) =>
    (await apiRequest<{ readers: MessageReader[] }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/readers`,
    )).readers,
  sendMessage: async (conversationId: string, text: string, clientId: string, replyToMessageId?: string) =>
    (await apiRequest<{ message: Message }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: "POST", body: JSON.stringify({ text, clientId, ...(replyToMessageId ? { replyToMessageId } : {}) }) },
    )).message,
  editMessage: async (conversationId: string, messageId: string, text: string, revision: number) =>
    (await apiRequest<{ message: Message }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body: JSON.stringify({ text, revision }) },
    )).message,
  deleteMessage: async (conversationId: string, messageId: string, revision: number) =>
    (await apiRequest<{ message: Message }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE", body: JSON.stringify({ revision }) },
    )).message,
  setMessagePinned: async (conversationId: string, messageId: string, pinned: boolean) =>
    (await apiRequest<{ message: Message }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/pin`,
      { method: "PUT", body: JSON.stringify({ pinned }) },
    )).message,
  forwardMessage: async (
    sourceConversationId: string,
    messageId: string,
    destinationConversationId: string,
    clientId: string,
  ) =>
    (await apiRequest<{ message: Message }>(
      `/conversations/${encodeURIComponent(sourceConversationId)}/messages/${encodeURIComponent(messageId)}/forward`,
      { method: "POST", body: JSON.stringify({ destinationConversationId, clientId }) },
    )).message,
  sendImage: uploadImage,
  loadPrivateImage,
};

export const socketUrl = API_BASE;
