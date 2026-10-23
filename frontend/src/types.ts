export interface User {
  id: string;
  displayName: string;
  bio: string;
  email: string;
  avatarUrl: string | null;
}

export interface SearchUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface DirectConversation {
  kind?: "direct";
  id: string;
  otherUser: SearchUser;
  latestMessage: { text: string; createdAt: string | null } | null;
}

export interface GroupMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: "admin" | "member";
  joinedAt: string;
}

export interface GroupConversation {
  kind: "group";
  id: string;
  name: string;
  photoReference: string | null;
  photoUrl: string | null;
  currentRole: "admin" | "member";
  members: GroupMember[];
  latestMessage: { text: string; createdAt: string | null } | null;
}

export type Conversation = DirectConversation | GroupConversation;

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: "text" | "image";
  text: string;
  createdAt: string;
  revision?: number;
  editedAt?: string;
  deletedAt?: string;
  pinnedAt?: string;
  reply?: {
    id: string;
    senderName: string;
    text: string;
    type: "text" | "image";
  };
  forwardedFrom?: {
    senderName: string;
    createdAt: string;
  };
  sender?: { displayName: string; avatarUrl: string | null };
  image?: {
    contentType: "image/jpeg" | "image/png" | "image/webp";
    size: number;
    width: number;
    height: number;
    url: string;
  };
}

export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}

export interface ReadPosition {
  userId: string;
  messageId: string;
  createdAt: string;
  joinedAt: string;
}

export interface MessageReader {
  userId: string;
  displayName: string;
}
