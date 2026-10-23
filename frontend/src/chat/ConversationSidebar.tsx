import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { useAuth } from "../auth/AuthProvider";
import { ProfilePhotoDialog } from "../auth/ProfilePhotoDialog";
import { chatApi } from "../lib/api";
import type { Conversation } from "../types";
import { Avatar, formatTime } from "./chat-utils";

export function ConversationSidebar({
  activeId,
  socketConnected,
  onSelect,
}: {
  activeId: string | null;
  socketConnected: boolean;
  onSelect: (conversationId: string) => void;
}) {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [conversationFilter, setConversationFilter] = useState("");
  const [groupMode, setGroupMode] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [logoutError, setLogoutError] = useState("");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const profileEditorButton = useRef<HTMLButtonElement>(null);
  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: chatApi.conversations,
  });
  const searchQuery = useInfiniteQuery({
    queryKey: ["user-search", search],
    queryFn: ({ pageParam }) => chatApi.searchUsers(search, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: search.trim().length >= 2,
    staleTime: 15_000,
  });
  const people = searchQuery.data?.pages.flatMap((page) => page.users) ?? [];
  const visibleConversations = (conversationsQuery.data ?? []).filter((item) => {
    const needle = conversationFilter.trim().toLowerCase();
    return !needle ||
      (item.kind === "group" ? item.name : item.otherUser.displayName).toLowerCase().includes(needle) ||
      item.latestMessage?.text.toLowerCase().includes(needle);
  });

  const createConversation = useMutation({
    mutationFn: (otherUserId: string) => chatApi.createConversation(otherUserId),
    onSuccess: (conversation) => {
      queryClient.setQueryData<Conversation[]>(["conversations"], (current = []) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ]);
      onSelect(conversation.id);
      setSearch("");
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const createGroup = useMutation({
    mutationFn: () => chatApi.createGroup(groupName.trim(), selectedMemberIds),
    onSuccess: (conversation) => {
      queryClient.setQueryData<Conversation[]>(["conversations"], (current = []) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ]);
      onSelect(conversation.id);
      setGroupMode(false);
      setGroupName("");
      setSelectedMemberIds([]);
      setSearch("");
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const queryError =
    conversationsQuery.error instanceof Error ? conversationsQuery.error.message : "";

  function closeProfileEditor() {
    setProfileEditorOpen(false);
    requestAnimationFrame(() => profileEditorButton.current?.focus());
  }

  return (
    <aside className="sidebar" aria-label="Conversations">
      <header className="sidebar-header">
        <div className="brand-lockup">
          <img className="brand-mark small logo-image" src="/converse-logo.png" alt="Converse logo" />
          <div>
            <span className="eyebrow">YOUR SPACE</span>
            <h1>Messages</h1>
          </div>
        </div>
        <details className="profile-menu">
          <summary aria-label={`Account menu for ${user?.displayName ?? "account"}`}>
            <Avatar name={user?.displayName ?? "?"} avatarUrl={user?.avatarUrl} />
          </summary>
          <div className="profile-popover">
            <strong>{user?.displayName}</strong>
            <span>{user?.email}</span>
            {logoutError && <span className="inline-error" role="alert">{logoutError}</span>}
            <button
              ref={profileEditorButton}
              type="button"
              className="quiet-button"
              onClick={() => setProfileEditorOpen(true)}
            >
              Edit profile
            </button>
            <button
              type="button"
              className="quiet-button"
              onClick={async () => {
                try {
                  await logout();
                } catch {
                  setLogoutError("Sign out failed. Please try again.");
                }
              }}
            >
              Sign out
            </button>
          </div>
        </details>
      </header>

      <label className="search-box">
        <span className="sr-only">Search conversations</span>
        <span aria-hidden="true" className="search-icon">⌕</span>
        <input
          value={conversationFilter}
          onChange={(event) => setConversationFilter(event.target.value)}
          placeholder="Search conversations"
        />
      </label>

      <section className="people-search" aria-labelledby="new-chat-heading">
        <div className="people-search-heading">
          <h2 id="new-chat-heading">{groupMode ? "Create a group" : "Start a conversation"}</h2>
          <button
            type="button"
            className="quiet-button group-mode-button"
            aria-pressed={groupMode}
            onClick={() => {
              setGroupMode((current) => !current);
              setSelectedMemberIds([]);
              createGroup.reset();
            }}
          >
            {groupMode ? "Cancel" : "New group"}
          </button>
        </div>
        {groupMode && (
          <label className="group-name-field">
            <span className="sr-only">Group name</span>
            <input
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder="Group name"
              maxLength={80}
            />
          </label>
        )}
        <label className="search-box compact">
          <span className="sr-only">Find people by name or email</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find someone..."
          />
        </label>
        {search.trim().length >= 2 && (
          <div className="search-results" aria-live="polite">
            {searchQuery.isLoading && <p className="muted-note">Searching...</p>}
            {searchQuery.error && <p className="inline-error">Search is unavailable right now.</p>}
            {searchQuery.data && people.length === 0 && <p className="muted-note">No people found.</p>}
            {people.map((person) => (
              <button
                type="button"
                className={`person-result ${selectedMemberIds.includes(person.id) ? "selected" : ""}`}
                key={person.id}
                disabled={groupMode ? createGroup.isPending : createConversation.isPending}
                aria-pressed={groupMode ? selectedMemberIds.includes(person.id) : undefined}
                onClick={() => {
                  if (!groupMode) {
                    createConversation.mutate(person.id);
                    return;
                  }
                  setSelectedMemberIds((current) =>
                    current.includes(person.id)
                      ? current.filter((id) => id !== person.id)
                      : [...current, person.id],
                  );
                }}
              >
                <Avatar name={person.displayName} avatarUrl={person.avatarUrl} />
                <span>{person.displayName}</span>
                <span className="result-action" aria-hidden="true">
                  {groupMode && selectedMemberIds.includes(person.id) ? "✓" : "+"}
                </span>
              </button>
            ))}
            {createConversation.error && (
              <p className="inline-error">{createConversation.error.message}</p>
            )}
            {searchQuery.hasNextPage && (
              <button
                type="button"
                className="load-older"
                onClick={() => void searchQuery.fetchNextPage()}
                disabled={searchQuery.isFetchingNextPage}
              >
                {searchQuery.isFetchingNextPage ? "Loading..." : "Show more people"}
              </button>
            )}
          </div>
        )}
        {groupMode && (
          <div className="group-create-actions">
            <p className="muted-note">Select at least two people. You’ll be the group admin.</p>
            <button
              type="button"
              className="primary-button"
              disabled={groupName.trim().length === 0 || selectedMemberIds.length < 2 || createGroup.isPending}
              onClick={() => createGroup.mutate()}
            >
              {createGroup.isPending ? "Creating..." : `Create group${selectedMemberIds.length ? ` (${selectedMemberIds.length})` : ""}`}
            </button>
            {createGroup.error && <p className="inline-error" role="alert">{createGroup.error.message}</p>}
          </div>
        )}
      </section>

      <section className="conversation-section" aria-labelledby="recent-heading">
        <div className="section-title">
          <h2 id="recent-heading">Recent</h2>
          <span>{visibleConversations.length}</span>
        </div>
        {conversationsQuery.isLoading && (
          <p className="muted-note section-message">Loading conversations...</p>
        )}
        {queryError && (
          <div className="error-panel">
            <p>{queryError}</p>
            <button type="button" className="quiet-button" onClick={() => void conversationsQuery.refetch()}>
              Try again
            </button>
          </div>
        )}
        {!conversationsQuery.isLoading && !queryError && visibleConversations.length === 0 && (
          <p className="muted-note section-message">
            {conversationFilter ? "No matching conversations." : "Your conversations will appear here."}
          </p>
        )}
        <div className="conversation-list">
          {visibleConversations.map((conversation) => (
            <button
              className={`conversation-item ${activeId === conversation.id ? "selected" : ""}`}
              key={conversation.id}
              type="button"
              onClick={() => onSelect(conversation.id)}
            >
              <Avatar
                name={conversation.kind === "group" ? conversation.name : conversation.otherUser.displayName}
                avatarUrl={conversation.kind === "group" ? conversation.photoUrl : conversation.otherUser.avatarUrl}
                className="large"
                fallback={conversation.kind === "group" ? "group" : "initial"}
              />
              <span className="conversation-copy">
                <span className="conversation-name">
                  {conversation.kind === "group" ? conversation.name : conversation.otherUser.displayName}
                </span>
                <span className="conversation-preview">
                  {conversation.latestMessage?.text ?? "Say hello"}
                </span>
              </span>
              <time className="conversation-time">
                {conversation.latestMessage?.createdAt
                  ? formatTime(conversation.latestMessage.createdAt)
                  : ""}
              </time>
            </button>
          ))}
        </div>
      </section>
      <footer className="sidebar-footer">
        <span className={`status-dot ${socketConnected ? "online" : ""}`} />
        {socketConnected ? "Live connection" : "Connecting..."}
      </footer>
      {profileEditorOpen && <ProfilePhotoDialog onClose={closeProfileEditor} />}
    </aside>
  );
}
