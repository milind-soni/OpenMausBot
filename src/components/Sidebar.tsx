import { track } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BellDot,
  Bot as BotIcon,
  Check,
  ClipboardCopy,
  Copy,
  EyeOff,
  Eraser,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  LayoutGrid,
  FolderKanban,
  ListTodo,
  Trash2,
  Users,
} from "lucide-react";
import { useStore, formatTime, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { MausAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";

const isElectron = navigator.userAgent.includes("Electron");

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

function formatMessagePreview(m: Message): string {
  if (m.kind === "options" && m.card) return m.card.title;
  if (m.kind === "activity" && m.tool) return m.tool.name;
  if (m.kind === "screen") return "Screen frame";
  const attLabel = m.attachments && m.attachments.length > 0
    ? m.attachments.length === 1
      ? m.attachments[0].mimeType?.startsWith("image/") ? `[Image: ${m.attachments[0].name}]` : `[File: ${m.attachments[0].name}]`
      : `[${m.attachments.length} attachments]`
    : "";
  if (m.text && attLabel) return `${attLabel} ${m.text}`;
  if (attLabel) return attLabel;
  return m.text ?? "";
}

function preview(bot: Bot): string {
  if (bot.busy) return "Working…";
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  return formatMessagePreview(last);
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

interface ClearTarget {
  id: string;
  threadId: string;
  name: string;
  kind: "chat" | "room";
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "A bot"} is working…`;
  }
  const last = group.messages.at(-1);
  if (!last) return "No messages yet";
  const formatted = formatMessagePreview(last);
  if (last.role === "user") return `You: ${formatted}`;
  return last.from ? `${last.from.name}: ${formatted}` : formatted;
}

/** Room avatar: 2–3 overlapping mauses in the same 56px slot a bot gets. */
function StackedMauses({ members }: { members: Bot[] }) {
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className="flex size-14 shrink-0 items-center justify-center">
        {b ? <MausAvatar color={b.color} state="happy" size={56} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className="flex size-14 shrink-0 items-center justify-center">
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <MausAvatar key={b.id} color={b.color} state="happy" size={30} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-[22px] items-center justify-center rounded-full border border-hairline/40 bg-raised text-[10px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupListItem({
  group,
  onMenu,
  collapsed,
}: {
  group: Group;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
  collapsed?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <button
      data-conversation-id={group.id}
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      aria-label={collapsed ? group.name : undefined}
      title={collapsed ? group.name : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl text-left",
        collapsed ? "justify-center p-2.5 w-auto" : "w-full px-3 py-2.5",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <StackedMauses members={members} />
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[15px] font-semibold text-ink">{group.name}</span>
            {selected && last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at)}</span>}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] text-ink-secondary">{groupPreview(group, state.bots)}</span>
            {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
          </div>
        </div>
      )}
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onClear,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onClear: (target: ClearTarget) => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const top = Math.min(menu.y, window.innerHeight - 160);
  const left = Math.min(menu.x, window.innerWidth - 240);
  const clearDisabled = Boolean(group.busyBotId) || (group.queuedBotIds?.length ?? 0) > 0 || group.messages.length === 0;
  const clearHint = group.messages.length === 0
    ? "This room has no history to clear"
    : clearDisabled
      ? "Wait for the room's agents to finish before clearing"
      : "Permanently clear this room's messages";
  return (
    <div
      data-room-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        Copy conversation ID
      </button>
      <button
        disabled={clearDisabled}
        title={clearHint}
        onClick={() => {
          onClear({ id: group.id, threadId: group.threadId, name: group.name, kind: "room" });
          onClose();
        }}
        className={cn(
          "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger",
          clearDisabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
        )}
      >
        <Eraser size={16} />
        Clear chat history
      </button>
      <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Delete Room
      </button>
    </div>
  );
}

/** Pick members → Create. The room name is optional; the server defaults it. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({ type: "createGroup", memberIds: [...picked], name: name.trim() || undefined });
    track("room_created", { members: picked.size });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">New Room</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Room name (optional)"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {bots.length === 0 && (
            <div className="px-2 py-4 text-center text-[13px] text-ink-secondary">Create a bot first — rooms are made of bots.</div>
          )}
          {bots.map((b) => (
            <button
              key={b.id}
              onClick={() => toggle(b.id)}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
            >
              <MausAvatar color={b.color} state="happy" size={28} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{b.name}</span>
              <span
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                  picked.has(b.id) ? "border-accent bg-accent text-white" : "border-hairline/60",
                )}
              >
                {picked.has(b.id) && <Check size={12} />}
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          Create Room{picked.size ? ` · ${picked.size} ${picked.size === 1 ? "bot" : "bots"}` : ""}
        </button>
      </div>
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onClear,
}: {
  menu: MenuState;
  onClose: () => void;
  onClear: (target: ClearTarget) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  // keep the menu on-screen near the click
  const top = Math.min(menu.y, window.innerHeight - 340);
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to new section", undefined, {
          disabled: true,
          hint: "Coming soon",
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(<Eraser size={16} />, "Clear chat history", () =>
          onClear({ id: bot.id, threadId: bot.threadId, name: bot.name, kind: "chat" }), {
          danger: true,
          disabled: Boolean(bot.busy) || bot.messages.length === 0,
          hint: bot.messages.length === 0
            ? "This chat has no history to clear"
            : bot.busy
              ? "Wait for the agent to finish before clearing"
              : "Permanently clear this chat's messages",
        }),
        item(<EyeOff size={16} className="text-ink-secondary" />, "Hide from sidebar", () =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { hidden: true } }),
        ),
        item(<Trash2 size={16} />, "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
        }),
      ]}
    </div>
  );
}

function BotListItem({
  bot,
  onMenu,
  collapsed,
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  collapsed?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  return (
    <button
      data-conversation-id={bot.id}
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      aria-label={collapsed ? bot.name : undefined}
      title={collapsed ? bot.name : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl text-left",
        collapsed ? "justify-center p-2.5 w-auto" : "w-full px-3 py-2.5",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <MausAvatar
        color={bot.color}
        state={stateForBot({ ...bot, messages: visible })}
        size={56}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
      />
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
              {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
              <span className="truncate">{bot.name}</span>
            </span>
            {selected && last && (
              <span className="shrink-0 text-xs text-ink-secondary">
                {formatTime(last.at)}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] text-ink-secondary">
              {preview(bot)}
            </span>
            {bot.unread && (
              <span className="size-2 shrink-0 rounded-full bg-accent" />
            )}
          </div>
        </div>
      )}
    </button>
  );
}

function ClearChatDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: ClearTarget;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-chat-title"
        aria-describedby="clear-chat-description"
        className="w-full max-w-[420px] rounded-2xl border border-hairline/50 bg-card p-5 shadow-2xl shadow-black/70"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
            <AlertTriangle size={20} />
          </span>
          <div className="min-w-0">
            <h2 id="clear-chat-title" className="text-[16px] font-semibold text-ink">
              Clear history {target.kind === "room" ? `in ${target.name}` : `with ${target.name}`}?
            </h2>
            <p id="clear-chat-description" className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">
              This permanently removes every message and activity from this conversation. {target.name} will remain, but this history cannot be recovered.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            className="rounded-lg bg-raised px-3.5 py-2 text-[14px] font-medium text-ink hover:brightness-110"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-danger px-3.5 py-2 text-[14px] font-medium text-white hover:brightness-110"
          >
            Clear history
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ collapsed = false }: { collapsed?: boolean } = {}) {
  const { state, dispatch } = useStore();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const visibleBots = state.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q),
    )
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const visibleGroups = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  const taskCounts = {
    todo: state.tasks.filter((task) => task.status === "todo").length,
    doing: state.tasks.filter((task) => task.status === "doing").length,
    review: state.tasks.filter((task) => task.status === "review").length,
    done: state.tasks.filter((task) => task.status === "done").length,
  };
  const totalTaskCount = taskCounts.todo + taskCounts.doing + taskCounts.review + taskCounts.done;
  const closeClearDialog = () => {
    const targetId = clearTarget?.id;
    setClearTarget(null);
    if (targetId) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-conversation-id="${targetId}"]`)?.focus();
      });
    }
  };

  return (
    <aside className={cn("flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel", collapsed ? "w-[68px] items-center" : "w-[320px]")}>
      {/* Titlebar: real traffic lights in Electron, faux ones in the browser */}
      <div
        className={cn("flex items-center pt-3.5 pb-1 px-4", collapsed ? "justify-center w-full" : "justify-between")}
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {!collapsed && (
          isElectron ? (
            <div className="w-14" />
          ) : (
            <div className="flex items-center gap-2">
              <span className="size-3 rounded-full bg-[#ff5f57]" />
              <span className="size-3 rounded-full bg-[#febc2e]" />
              <span className="size-3 rounded-full bg-[#28c840]" />
            </div>
          )
        )}
        <div className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button
            onClick={() => setPlusOpen((o) => !o)}
            aria-label="New bot or room"
            aria-expanded={plusOpen}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="New bot or room"
          >
            <Plus size={20} strokeWidth={2} aria-hidden="true" />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} aria-hidden="true" />
              <div role="menu" aria-label="Create options" className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
                <button
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" aria-hidden="true" />
                  <span>New Bot</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" aria-hidden="true" />
                  <span>New Room</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search */}
      {!collapsed && (
        <div className="px-3 pt-2 pb-3 w-full">
          <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
            <Search size={16} className="text-ink-secondary" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search"
              aria-label="Search bots"
              className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2 w-full">
        <div className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
          {visibleBots.length === 0 && visibleGroups.length === 0 && q && !collapsed && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">Nothing matches “{query}”</div>
          )}
          {visibleGroups.map((g) => (
            <GroupListItem key={g.id} group={g} onMenu={setRoomMenu} collapsed={collapsed} />
          ))}
          {visibleBots.map((b) => (
            <BotListItem key={b.id} bot={b} onMenu={setMenu} collapsed={collapsed} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className={cn("px-3 pb-3 pt-2 flex flex-col gap-1", collapsed ? "w-full items-center px-1" : "w-full")}>
        <button
          onClick={() => dispatch({ type: "toggleTaskBoard", open: true })}
          aria-label={`Task Board, ${totalTaskCount} tasks`}
          title={collapsed ? `Task Board (${totalTaskCount})` : undefined}
          className={cn(
            "flex items-center gap-3 rounded-xl p-2 text-left",
            collapsed ? "justify-center p-2.5" : "w-full px-3 py-2",
            state.taskBoardOpen ? "bg-raised" : "hover:bg-raised/50",
          )}
        >
          <ListTodo size={20} className={state.taskBoardOpen ? "text-accent" : "text-ink-secondary"} aria-hidden="true" />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 text-[14px] text-ink">Task Board</span>
              {totalTaskCount > 0 && (
                <span
                  className="flex items-center gap-2"
                  title={`${taskCounts.todo} todo · ${taskCounts.doing} doing · ${taskCounts.review} review · ${taskCounts.done} done`}
                >
                  {([
                    ["todo", "bg-ink-secondary"],
                    ["doing", "bg-accent"],
                    ["review", "bg-warning"],
                    ["done", "bg-success"],
                  ] as const).map(([status, dotColor]) =>
                    taskCounts[status] > 0 ? (
                      <span key={status} className="flex items-center gap-1">
                        <span className={cn("size-1.5 rounded-full", dotColor)} />
                        <span className="text-[10px] tabular-nums text-ink-secondary">{taskCounts[status]}</span>
                      </span>
                    ) : null,
                  )}
                </span>
              )}
            </>
          )}
        </button>

        <button
          onClick={() => dispatch({ type: "toggleProjects", open: true })}
          aria-label="Projects"
          title={collapsed ? "Projects" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-xl p-2 text-left",
            collapsed ? "justify-center p-2.5" : "w-full px-3 py-2",
            state.projectsOpen ? "bg-raised" : "hover:bg-raised/50",
          )}
        >
          <FolderKanban size={20} className={state.projectsOpen ? "text-accent" : "text-ink-secondary"} aria-hidden="true" />
          {!collapsed && <span className="text-[14px] text-ink">Projects</span>}
        </button>

        <button
          onClick={() => dispatch({ type: "toggleApps", open: true })}
          aria-label="Apps"
          title={collapsed ? "Apps" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-xl p-2 text-left",
            collapsed ? "justify-center p-2.5" : "w-full px-3 py-2",
            state.appsOpen ? "bg-raised" : "hover:bg-raised/50",
          )}
        >
          <LayoutGrid size={20} className={state.appsOpen ? "text-accent" : "text-ink-secondary"} aria-hidden="true" />
          {!collapsed && <span className="text-[14px] text-ink">Apps</span>}
        </button>

        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={() => dispatch({ type: "toggleAppSettings" })}
              aria-label="App settings"
              title="App settings"
              className={cn(
                "flex items-center justify-center rounded-xl p-2.5 text-ink-secondary hover:bg-raised hover:text-ink",
                state.appSettingsOpen && "bg-raised text-accent",
              )}
            >
              <Settings size={20} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <button
              onClick={() => dispatch({ type: "toggleAppSettings" })}
              aria-label={`User profile: ${state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}`}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left",
                state.appSettingsOpen ? "bg-raised" : "hover:bg-raised/50",
              )}
            >
              <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
              <span className="truncate text-[14px] text-ink">
                {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
              </span>
            </button>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings" })}
              aria-label="App settings"
              className={cn(
                "rounded-md p-2",
                state.appSettingsOpen
                  ? "bg-raised text-accent"
                  : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
              title="App settings"
            >
              <Settings size={18} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {menu && <BotContextMenu menu={menu} onClose={() => setMenu(null)} onClear={setClearTarget} />}
      {roomMenu && <RoomContextMenu menu={roomMenu} onClose={() => setRoomMenu(null)} onClear={setClearTarget} />}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {clearTarget && (
        <ClearChatDialog
          target={clearTarget}
          onClose={closeClearDialog}
          onConfirm={() => {
            dispatch({ type: "clearChat", threadId: clearTarget.threadId });
            closeClearDialog();
          }}
        />
      )}
    </aside>
  );
}
