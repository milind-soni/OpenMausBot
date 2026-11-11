"use client";
import { focusQuietly } from "@/lib/initial-focus";
import { errorText } from "@/lib/error-text";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "convex/react";
import {
  Loader2,
  MessageCircle,
  Pencil,
  Pin,
  Search,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DirectConversation } from "@/lib/chat-types";
import { localApi } from "@/lib/client-api";
import { useMemberProfile, useWorkspace } from "./workspace-context";
import { Dialog } from "./dialog";
import { RECONNECT_TO_CREATE, useWorkspaceOnline } from "./workspace-connection";

import { ContentSkeleton } from "./content-skeleton";
import { UserAvatar, memberName, type AvatarIdentity } from "./user-avatar";
import { formatDateTime, formatRelative } from "@/lib/format";
import { ChatThread } from "./chat-view";

export type ChatMember = AvatarIdentity & {
  userId?: Id<"users"> | null;
  email: string;
  name: string;
};
const NARROW = "(max-width: 760px)";
const isNarrow = () => window.matchMedia(NARROW).matches;
const subscribeNarrow = (change: () => void) => {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
type Props = {
  sessionToken: string;
  user: AvatarIdentity & { _id: Id<"users">; name: string; email: string };
  onOpenReference: (projectId: Id<"projects">, taskId?: Id<"tasks">) => void;
  focusMessageId?: string;
};

export function ChatView(props: Props) {
  const id = useId();
  const online = useWorkspaceOnline();
  const workspace = useWorkspace(),
    openMember = useMemberProfile();
  const members = useQuery(api.workspaces.members, {
    sessionToken: props.sessionToken,
    teamId: workspace._id,
  });
  const [section, setSection] = useState<"chat" | "dm">("chat");
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const [chosen, setSelected] = useState<{
    id: string;
    userId: string;
    unread?: number;
  } | null>(null);
  const [conversations, setConversations] = useState<
    DirectConversation[] | null
  >(null);
  const [peopleOpen, setPeopleOpen] = useState(false),
    [peopleQuery, setPeopleQuery] = useState("");
  const [notice, setNotice] = useState(""),
    [opening, setOpening] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const endpoint = `/api/local-chat/conversations?teamId=${workspace._id}`;
  const refreshConversations = useCallback(
    async (signal?: AbortSignal) => {
      const result = await localApi<{ conversations: DirectConversation[] }>(
        endpoint,
        props.sessionToken,
        { signal },
      );
      if (!signal?.aborted) setConversations(result.conversations);
    },
    [endpoint, props.sessionToken],
  );
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        await refreshConversations(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted)
          setNotice(
            errorText(error, "Could not load direct messages"),
          );
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refreshConversations]);
  useEffect(() => {
    if (props.focusMessageId) {
      setSection("chat");
      setQuery("");
      setPinnedOnly(false);
    }
  }, [props.focusMessageId]);
  const startDirect = async (member: ChatMember) => {
    if (!member.userId || member.userId === props.user._id || opening) return;
    setOpening(member.userId);
    setNotice("");
    try {
      const result = await localApi<{ conversationId: string }>(
        endpoint,
        props.sessionToken,
        { method: "POST", json: { recipientId: member.userId } },
      );
      setSelected({ id: result.conversationId, userId: member.userId });
      setSection("dm");
      setPeopleOpen(false);
      setQuery("");
      setPinnedOnly(false);
      await refreshConversations();
    } catch (error) {
      setNotice(
        errorText(error, "Could not open conversation"),
      );
    } finally {
      setOpening(null);
    }
  };
  // Wide screens show the list and a conversation side by side: the first time the list arrives, the latest
  // conversation opens and stays open. A new message elsewhere only reorders the list; it never takes over the thread.
  const latest = conversations?.[0];
  if (!chosen && section === "dm" && !narrow && latest) setSelected({ id: latest.id, userId: latest.otherUserId, unread: latest.unread });
  const selected = chosen;
  const peers =
    members?.filter(
      (member) => member.userId && member.userId !== props.user._id,
    ) || [];
  const recipient = members?.find(
    (member) => member.userId === selected?.userId,
  );
  const unread =
    conversations?.reduce(
      (total, conversation) => total + conversation.unread,
      0,
    ) || 0;
  // Teammates without a conversation yet sit under the conversations, one tap from a first message.
  const newPeople = conversations ? peers.filter(member => !conversations.some(conversation => conversation.otherUserId === member.userId)) : [];
  const matches = peers.filter((member) =>
    `${member.name} ${member.username || ""} ${member.email}`
      .toLowerCase()
      .includes(peopleQuery.toLowerCase()),
  );
  const selectSection = (value: "chat" | "dm") => {
    setSection(value);
    setQuery("");
    setPinnedOnly(false);
    setSearchOpen(false);
  };
  return (
    <section className="team-chat" aria-label="Chat">
      <header className="chat-toolbar">
        <div className="chat-tabs" role="tablist" aria-label="Conversations" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          const target = tabs[next];
          target?.click(); requestAnimationFrame(() => target?.focus());
        }}>
          <button
            role="tab"
            id={`${id}-chat`}
            aria-controls={`${id}-panel`}
            tabIndex={section === "chat" ? 0 : -1}
            aria-selected={section === "chat"}
            onClick={() => selectSection("chat")}
          >
            Chat
          </button>
          <button
            role="tab"
            id={`${id}-dm`}
            aria-controls={`${id}-panel`}
            tabIndex={section === "dm" ? 0 : -1}
            aria-selected={section === "dm"}
            onClick={() => selectSection("dm")}
          >
            DMs
            {unread > 0 && (
              <span className="notification-count">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        </div>
        <div className="chat-utilities">
          <div className="chat-members" aria-label="Workspace members">
            {peers.slice(0, 3).map((member) => (
              <button
                key={member.userId}
                className="chat-member"
                title={!online ? RECONNECT_TO_CREATE : `Message ${memberName(member)}`}
                aria-label={`Message ${memberName(member)}`}
                disabled={!online || Boolean(opening) || workspace.role === "viewer"}
                onClick={() => void startDirect(member)}
              >
                <UserAvatar user={member} size="small" />
              </button>
            ))}
            {peers.length > 0 && <button
              className="icon-button chat-members-browse"
              aria-label="Browse members"
              title="Browse members"
              onClick={() => setPeopleOpen(true)}
            >
              {peers.length > 3 && <span>+{peers.length - 3}</span>}
              <Users size={17} />
            </button>}
          </div>
          {(section === "chat" || selected) && <>
            <button
              ref={searchButton}
              className={`icon-button ${query ? "selected" : ""}`}
              aria-label="Search messages"
              title="Search messages"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen(!searchOpen)}
            >
              <Search size={17} />
            </button>
            <button
              className={`icon-button ${pinnedOnly ? "selected" : ""}`}
              title="Pinned messages"
              aria-label="Pinned messages"
              aria-pressed={pinnedOnly}
              onClick={() => setPinnedOnly(!pinnedOnly)}
            >
              <Pin size={16} />
            </button>
          </>}
        </div>
      </header>
      {searchOpen && (
        <div className="chat-search">
          <Search size={16} />
          <input
            autoFocus
            aria-label="Search messages"
            placeholder="Search messages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchOpen(false);
                focusQuietly(searchButton.current);
              }
            }}
          />
          <button
            className="icon-button"
            aria-label="Close message search"
            onClick={() => {
              setQuery("");
              setSearchOpen(false);
              focusQuietly(searchButton.current);
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="notice danger" role="alert">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss chat error"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${section}`}
        tabIndex={0}
        className={`chat-body ${section === "dm" ? "direct-chat" : ""} ${selected ? "has-conversation" : ""}`}
      >
        {section === "dm" && (
          <aside className="dm-list" aria-label="Direct conversations">
            <div className="dm-list-heading">
              <span>Messages</span>
              {peers.length > 0 && <button
                className="icon-button"
                title={!online ? RECONNECT_TO_CREATE : "New message"}
                disabled={!online}
                aria-label="New direct message"
                onClick={() => setPeopleOpen(true)}
              >
                <Pencil size={15} />
              </button>}
            </div>
            {conversations === null ? (
              <ContentSkeleton
                kind="chat"
                rows={4}
                label="Loading direct messages"
              />
            ) : (<>
              {              conversations.map((conversation) => {
                const member = members?.find(
                  (member) => member.userId === conversation.otherUserId,
                );
                return (
                  <button
                    key={conversation.id}
                    className={`dm-row ${selected?.id === conversation.id ? "active" : ""}`}
                    aria-current={
                      selected?.id === conversation.id ? "true" : undefined
                    }
                    onClick={() => {
                      setSelected({
                        id: conversation.id,
                        userId: conversation.otherUserId,
                        unread: conversation.unread,
                      });
                      setQuery("");
                      setPinnedOnly(false);
                    }}
                  >
                    <UserAvatar user={member || { name: "Former member" }} />
                    <span className="dm-row-copy">
                      <strong>
                        {member ? memberName(member) : "Former member"}
                      </strong>
                      <span>
                        {conversation.lastMessage?.body ||
                          (conversation.lastMessage?.attachments?.length
                            ? "Attachment"
                            : "Start a conversation")}
                      </span>
                    </span>
                    <span className="dm-row-meta">
                      {conversation.lastMessage && (
                        <time dateTime={new Date(conversation.lastMessage.createdAt).toISOString()} title={formatDateTime(conversation.lastMessage.createdAt)}>
                          {formatRelative(conversation.lastMessage.createdAt)}
                        </time>
                      )}
                      {conversation.unread > 0 && (
                        <i
                          className="dm-unread"
                          aria-label={`${conversation.unread} unread messages`}
                        />
                      )}
                    </span>
                  </button>
                );
              })}
              {newPeople.length > 0 && <div className="dm-list-caption">People</div>}
              {newPeople.map(member => (
                <button
                  key={member.userId}
                  className="dm-row dm-person"
                  disabled={!online || workspace.role === "viewer" || Boolean(opening)}
                  title={!online ? RECONNECT_TO_CREATE : undefined}
                  onClick={() => void startDirect(member)}
                >
                  <UserAvatar user={member} />
                  <span className="dm-row-copy"><strong>{memberName(member)}</strong></span>
                  {opening === member.userId && <Loader2 className="spin" size={15} />}
                </button>
              ))}
              {!conversations.length && !newPeople.length && members !== undefined && <div className="dm-list-empty">No teammates yet</div>}
            </>)}
          </aside>
        )}
        {section === "chat" || selected ? (
          <ChatThread
            key={section === "chat" ? "workspace" : selected!.id}
            {...props}
            members={members}
            conversation={section === "dm" ? selected!.id : ""}
            recipient={section === "dm" ? recipient : undefined}
            onBack={() => setSelected(null)}
            query={query}
            pinnedOnly={pinnedOnly}
            onRead={refreshConversations}
            initialUnread={section === "dm" ? selected?.unread : 0}
          />
        ) : conversations?.length ? (
          <div className="dm-no-selection">
            <MessageCircle size={30} />
            <p>Select a conversation</p>
          </div>
        ) : <div className="dm-no-selection" />}
      </div>
      {peopleOpen && (
        <Dialog title="Members" onClose={() => setPeopleOpen(false)}>
          <div className="dialog-body stack-form">
            <label className="inline-search">
              <Search size={16} />
              <input
                autoFocus
                aria-label="Search members"
                placeholder="Find a teammate"
                value={peopleQuery}
                onChange={(event) => setPeopleQuery(event.target.value)}
              />
            </label>
            <div className="chat-people-list">
              {members === undefined ? (
                <ContentSkeleton kind="chat" rows={3} />
              ) : (
                matches.map((member) => (
                  <div key={member.userId}>
                    <button
                      className="chat-person-main"
                      title={!online ? RECONNECT_TO_CREATE : undefined} disabled={!online || workspace.role === "viewer" || Boolean(opening)}
                      onClick={() => void startDirect(member)}
                    >
                      <UserAvatar user={member} />
                      <span>
                        <strong>{memberName(member)}</strong>
                        {member.username && <small>@{member.username}</small>}
                      </span>
                      {opening === member.userId ? (
                        <Loader2 className="spin" size={16} />
                      ) : (
                        <MessageCircle size={17} />
                      )}
                    </button>
                    <button
                      className="icon-button"
                      title={`View ${memberName(member)} profile`}
                      aria-label={`View ${memberName(member)} profile`}
                      onClick={() => {
                        setPeopleOpen(false);
                        openMember(member.email);
                      }}
                    >
                      <UserRound size={16} />
                    </button>
                  </div>
                ))
              )}
              {members && !matches.length && (
                <p className="muted">No members found</p>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
