export interface User {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export interface SearchUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Conversation {
  id: string;
  otherUser: SearchUser;
  latestMessage: { text: string; createdAt: string | null } | null;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: "text" | "image";
  text: string;
  createdAt: string;
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
