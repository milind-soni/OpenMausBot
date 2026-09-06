import { track } from "@/lib/analytics";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDownToLine,
  BellDot,
  Bot as BotIcon,
  CalendarDays,
  Check,
  ClipboardCopy,
  Copy,
  Crown,
  FolderMinus,
  FolderPlus,
  Library,
  Loader2,
  Network,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  Search,
  Sparkles,
  Puzzle,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, type Bot, type Group } from "@/state/store";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { WorkingDots } from "./WorkingIndicator";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { nextRename } from "@/lib/rename";
import { downloadAllBots } from "@/lib/team-files";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel } from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import {
  loadCollapsedSections,
  loadSectionOrder,
  loadSidebarDensity,
  saveCollapsedSections,
  saveSectionOrder,
  saveSidebarDensity,
  toggleCollapsedSection,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sameSectionOrder,
  sidebarGoalRunPreview,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { botListItemPointerIntent } from "@/lib/sidebar-selection";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { SidebarMoreMenu } from "./SidebarMoreMenu";
import { profileInitials, SidebarProfileMenu } from "./SidebarProfileMenu";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

function preview(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return "Waiting for you…";
  if (bot.busy) return "Working…";
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "A bot"} is working…`;
  }
  if (group.working) return "The team is working…";
  const last = group.messages.at(-1);
  if (!last) return "No messages yet";
  const text = last.kind === "activity" && last.tool
    ? last.tool.name
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : (last.text ?? "");
  if (last.role === "user") return `You: ${text}`;
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** Room avatar: 2–3 overlapping mauses in the same 56px slot a bot gets. */
function StackedMauses({ members, density }: { members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : density === "compact" ? "size-10" : "size-14";
  const singleSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={30} animated={false} />
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
  density,
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <button
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-xl text-left",
        density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-2 px-2 py-1.5" : "gap-3 px-3 py-2.5",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? group.name : undefined}
    >
      <StackedMauses members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">{group.name}</span>
          {selected && last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">{groupPreview(group, state.bots)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
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
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(menu.y, window.innerHeight - 204);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      data-sidebar
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {!remoteClient && (renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={`Rename ${group.name}`}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={isBotChat ? "Save chat name" : "Save channel name"}
            title="Save"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={isBotChat ? "Cancel chat rename" : "Cancel channel rename"}
            title="Cancel"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          {isBotChat ? "Rename chat" : "Rename Channel"}
        </button>
      ))}
      {!remoteClient && !isBotChat && (
        <button
          onClick={() => {
            onClose();
            onMoveToSection(group.id);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <FolderPlus size={16} className="text-ink-secondary" />
          Move to context
        </button>
      )}
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
      {!remoteClient && <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        {isBotChat ? "Delete chat" : "Delete Channel"}
      </button>}
    </div>,
    document.body,
  );
}

/** Pick members and an optional Work/Personal/project context, then create. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
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
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(section.trim()) });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">New Channel</div>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Channel name (for example, Website launch)"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Context (optional): Work, Personal, Client…"
          aria-label="Channel context"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint="Create a bot first — channels are made of bots."
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          Create Channel{picked.size ? ` · ${picked.size} ${picked.size === 1 ? "bot" : "bots"}` : ""}
        </button>
      </div>
    </div>
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and channels alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
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

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-2 shadow-2xl shadow-black/60"
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Move to context
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === current ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === current && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New context…"
          aria-label="New context name"
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel" : "bg-raised/70 text-ink-secondary",
          )}
        >
          Add
        </button>
      </form>
      {current && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            Remove from context
          </button>
        </>
      )}
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onDelete,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onDelete: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
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
  const deleting = state.deletingBots[bot.id] === true;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? "Choose another Chief of Staff first"
    : visibleBotCount <= 1
      ? "Keep at least one active bot"
      : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
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
      {remoteClient ? [
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to section", () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
      ] : [
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(
          <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
          bot.chiefOfStaff ? "Remove Chief of Staff" : "Make Chief of Staff",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint: !bot.chiefOfStaff && !canCoordinate ? "Choose a Claude or ACP engine first" : undefined,
          },
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to section", () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true, section: "identity" });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          "Archive",
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        <BotDeleteMenuItem
          key="delete"
          deleting={deleting}
          onClick={() => {
            onClose();
            onDelete(bot);
          }}
        />,
      ]}
    </div>
  );
}

export type BotConfirmKind = "archive" | "delete";

/** A confirmation may span live fleet updates; never authorize from its snapshot. */
export function currentArchivableBot(bots: readonly Bot[], id: string): Bot | undefined {
  const active = bots.filter((candidate) => !candidate.hidden);
  if (active.length <= 1) return undefined;
  return active.find((candidate) => candidate.id === id && !candidate.chiefOfStaff);
}

/** Copy for the archive / delete confirmation dialogs. Archiving keeps
 * everything and is reversible from Archived bots; deleting is not — the
 * server drops every task transcript, the workspace (files + memory), and
 * staged skill state with the bot. */
export function botConfirmCopy(kind: BotConfirmKind, name: string) {
  return kind === "archive"
    ? {
        title: `Archive ${name}?`,
        body: `${name} leaves the sidebar, but every conversation is kept. You can restore it any time from Archived bots.`,
        confirmLabel: "Archive",
        tone: "neutral" as const,
      }
    : {
        title: `Delete ${name}?`,
        body: `This permanently removes ${name} along with its conversations, files, and memory. This cannot be undone.`,
        confirmLabel: "Delete",
        tone: "danger" as const,
      };
}

export function BotDeleteMenuItem({ deleting, onClick }: { deleting: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={deleting}
      aria-busy={deleting || undefined}
      onClick={onClick}
      title={deleting ? "Checking for persistent computers before deleting this bot" : undefined}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger",
        deleting ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      {deleting ? "Checking computers…" : "Delete"}
    </button>
  );
}

export function BotListItem({
  bot,
  density,
  onMenu,
  onArchive,
  archiveDisabled,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const [renaming, setRenaming] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const deleting = state.deletingBots[bot.id] === true;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const iconOnly = density === "icons";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  // the role from Bot Settings → Title, shown as a pill beside the name
  const title = bot.title.trim();
  const rowClass = cn(
    "flex w-full items-center rounded-xl border text-left",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : density === "compact"
        ? "gap-2 px-2 py-1.5 pr-12"
        : "gap-3 px-3 py-2.5 pr-12",
    // Chief of Staff is called out by the crown label below, not by tinting
    // the whole row — an accent border + fill read as "selected" even when
    // another bot was active.
    selected ? "border-transparent bg-raised" : "border-transparent hover:bg-raised/50",
  );
  const working = Boolean(bot.busy) && bot.activity !== "waiting-on-you";
  const body = (
    <>
      {/* flex, not inline: an inline wrapper adds a baseline gap under the
          avatar and makes the row taller than before the presence dot */}
      <span className="relative flex shrink-0">
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={avatarSize}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          // Motion means something is happening. A resting bot holds a resting
          // pose — N idle rows bobbing at display rate was most of the app's
          // visible-idle CPU (states are keyword-derived, so "working" can be
          // decorative; busy/unread/motion are the real signals).
          animated={Boolean(bot.busy) || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {working && (
          // presence dot: green while the bot is working, ringed in the row's
          // ground so it reads on both a photo and the mascot. Also the only
          // activity signal in icons-only density, where the text is hidden.
          <span
            data-testid="working-dot"
            className={cn(
              "absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-success",
              // scale with the avatar: 56px comfortable, 40/44px compact + icons
              density === "comfortable" ? "size-3.5" : "size-3",
            )}
          />
        )}
      </span>
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => {
                if (remoteClient) {
                  void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
                    .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
                    .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
                } else {
                  dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
                }
              }}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[15px] font-semibold"
            />
            {title && !renaming && (
              <span className="max-w-[120px] shrink-0 truncate rounded-full bg-control px-1.5 py-px text-[10.5px] font-medium text-ink-secondary">
                {title}
              </span>
            )}
          </span>
          {selected && last && !renaming && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        {bot.chiefOfStaff && !renaming && (
          // Chief of Staff gets its own line under the name so a long name
          // and the title badge keep the full width of the name line.
          <span className="flex items-center gap-1 text-[11.5px] font-medium leading-4 text-accent">
            <Crown size={11} className="shrink-0" /> Chief of Staff
          </span>
        )}
        <div className="flex items-center justify-between gap-2">
          {deleting ? (
            <span role="status" className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-ink-secondary">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              Checking computers before deleting…
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-ink-secondary">
              {bot.busy && bot.activity !== "waiting-on-you" ? (
                // the same typing dots as the chat header; sized to the text's
                // line box so the row does not jump when work starts or ends
                <span className="flex h-[1.5em] items-center" role="status">
                  <WorkingDots size={3.5} />
                  <span className="sr-only">Working…</span>
                </span>
              ) : (
                <span className="truncate">{preview(bot)}</span>
              )}
            </span>
          )}
          {bot.unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
  };
  const onSelect = (event: React.MouseEvent) => {
    if (renaming) return;
    const insideRenameInput = event.target instanceof HTMLInputElement;
    if (botListItemPointerIntent(event.type, insideRenameInput) === "select") {
      dispatch({ type: "select", id: bot.id });
    }
  };

  return (
    <div className="group relative" title={iconOnly ? bot.name : undefined}>
      {/* Keep this wrapper mounted while RenameTitle swaps its label for an
          input. Replacing the wrapper tree remounts RenameTitle, loses its
          editing state, and leaves the row stuck in rename mode. Omitting
          role=button also keeps the input visible to assistive technology. */}
      <div
        role={renaming ? undefined : "button"}
        tabIndex={renaming ? undefined : 0}
        aria-label={!renaming && iconOnly ? (deleting ? `${bot.name}, checking computers before deleting` : bot.name) : undefined}
        aria-busy={deleting || undefined}
        data-sidebar-bot-row={bot.id}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (renaming) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {!renaming && iconOnly && bot.unread && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
      {deleting && iconOnly && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-full bg-card p-1 text-ink-secondary">
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}
      {/* Disabled buttons still own their pixels in Chromium, even at zero
          opacity. Omit the unavailable action so the entire row stays live. */}
      {!remoteClient && !renaming && !deleting && !iconOnly && !archiveDisabled && !bot.chiefOfStaff && <button
        type="button"
        onClick={() => onArchive(bot)}
        aria-label={`Archive ${bot.name}`}
        title={`Archive ${bot.name}`}
        className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
      >
        <Archive size={14} />
      </button>}
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(`${bot.name} restored`);
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(`${bots.length} ${bots.length === 1 ? "bot" : "bots"} restored`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Archived bots</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">Conversations are kept until you choose to delete a bot.</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                Restore all
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label="Close archived bots"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">{bots.length} archived</div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <BotAvatar bot={bot} state="happy" size={42} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || "Bot"}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  Restore
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<{ kind: BotConfirmKind; bot: Bot } | null>(null);
  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  const [density, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [densityOpen, setDensityOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => loadCollapsedSections());
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => loadSectionOrder());
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
    setDensityOpen(false);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open || confirm) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, confirm]);

  useEffect(() => {
    if (!densityOpen) return;
    const closeDensityMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDensityOpen(false);
    };
    window.addEventListener("keydown", closeDensityMenu);
    return () => window.removeEventListener("keydown", closeDensityMenu);
  }, [densityOpen]);

  useEffect(() => {
    if (remoteClient) return;
    return window.ogb?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, [remoteClient]);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      track("team_exported", { members: exported.members, scope: "backup" });
      setTeamFeedback({ error: false, text: `Backup downloaded · ${exported.members} bots and conversation text. ${exported.warnings.length ? `${exported.warnings.length} backup notes about deleted bots/rooms—review them when importing. ` : ""}Keep this file private.` });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };


  // One pending confirmation at a time: archive (inline button or context
  // menu) and delete (context menu) both open the same dialog.
  const requestArchive = (bot: Bot) => {
    const current = currentArchivableBot(state.bots, bot.id);
    if (current) setConfirm({ kind: "archive", bot: current });
  };

  const archiveBot = async ({ id }: Pick<Bot, "id">) => {
    const bot = currentArchivableBot(state.bots, id);
    if (!bot) return;
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: `${bot.name} archived`,
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: `${bot.name} restored` });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  const matchingBots = state.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q),
    );
  const visibleGroups = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  const {
    unsectionedChief,
    pinnedBots,
    sectionChiefs,
    sectionedBots,
    unsectionedBots,
  } = partitionSidebarBots(matchingBots);
  const { botChats, sectionedRooms, unsectionedRooms } = partitionSidebarGroups(visibleGroups);

  // User sections keep first-appearance order. The saved layout keeps an
  // empty section's former slot so it returns there when content comes back.
  const sectionNames: string[] = [];
  for (const bot of sectionedBots) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const bot of sectionChiefs) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const group of sectionedRooms) {
    if (!sectionNames.includes(group.section!)) sectionNames.push(group.section!);
  }
  const naturalSectionIds = [
    ...(pinnedBots.length > 0 ? [PINNED_SECTION_ID] : []),
    ...(unsectionedRooms.length > 0 ? [CHANNELS_SECTION_ID] : []),
    ...(botChats.length > 0 ? [BOT_CHATS_SECTION_ID] : []),
    ...(unsectionedBots.length > 0 ? [BOTS_SECTION_ID] : []),
    ...sectionNames.map(userSectionId),
  ];
  const sectionIds = orderedSidebarSections(naturalSectionIds, sectionOrder);
  const layoutInteractive = sidebarLayoutInteractive(density, q);
  const sectionCollapsed = (id: string) =>
    sidebarSectionCollapsed(id, collapsedSections, density, q);

  const toggleSection = (id: string) => {
    if (!layoutInteractive) return;
    const next = toggleCollapsedSection(collapsedSections, id);
    setCollapsedSections(next);
    saveCollapsedSections(next);
  };

  const commitSectionOrder = (visibleOrder: string[]) => {
    if (!layoutInteractive) return;
    const next = mergeSectionOrder(sectionOrder, visibleOrder);
    if (sameSectionOrder(next, sectionOrder)) return;
    setSectionOrder(next);
    saveSectionOrder(next);
  };

  const announceSectionPosition = (id: string, visibleOrder: string[]) => {
    const position = visibleOrder.indexOf(id);
    if (position < 0) return;
    setReorderAnnouncement(
      `${sidebarSectionLabel(id)} moved to position ${position + 1} of ${visibleOrder.length}`,
    );
  };

  const moveSidebarSection = (id: string, direction: -1 | 1) => {
    const next = moveSection(sectionIds, id, direction);
    if (sameSectionOrder(next, sectionIds)) return;
    commitSectionOrder(next);
    announceSectionPosition(id, next);
  };

  const resetSectionDrag = () => {
    sectionDragRef.current = { from: null, over: null };
    setDraggingSectionId(null);
    setDropTarget(null);
  };

  const updateSectionDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!layoutInteractive || !sectionDragRef.current.from) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: SectionDropPlace = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const next = { id, place };
    sectionDragRef.current.over = next;
    setDropTarget(next);
  };

  const dropSection = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const from =
      event.dataTransfer.getData("application/x-openmausbot-sidebar-section") ||
      event.dataTransfer.getData("text/plain") ||
      sectionDragRef.current.from;
    const over = sectionDragRef.current.over;
    if (from && over) {
      const next = placeSection(sectionIds, from, over.id, over.place);
      if (!sameSectionOrder(next, sectionIds)) {
        commitSectionOrder(next);
        announceSectionPosition(from, next);
      }
    }
    resetSectionDrag();
  };
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const pendingBotUndo = teamFeedback?.restoreBot;

  return (
    <aside
      ref={sidebarRef}
      tabIndex={-1}
      aria-label="Bots and navigation"
      data-native-view-overlay
      data-sidebar
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel transition-[width] duration-200",
        density === "icons" ? "w-[80px]" : density === "compact" ? "w-[272px]" : "w-[320px]",
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents NewRoomPanel's overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn("flex items-center pt-3.5 pb-1", density === "icons" ? "flex-col gap-1 px-2" : "justify-between px-4")}
        style={windowDragStyle}
      >
        {macInset ? (
          <div className={density === "icons" ? "h-5 w-full" : "w-14"} />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : <div />}
        <div
          className={cn("relative flex items-center", density === "icons" ? "flex-col gap-1" : "gap-1")}
          style={windowNoDragStyle}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={density === "icons" ? "Expand sidebar" : "Collapse sidebar to avatars"}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={density === "icons" ? "Expand sidebar" : "Collapse to avatars"}
          >
            {density === "icons" ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setDensityOpen((value) => !value)}
              aria-label="Choose sidebar density"
              aria-expanded={densityOpen}
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              title="Sidebar density"
            >
              <span aria-hidden="true" className="flex size-5 flex-col items-center justify-center gap-[3px]">
                <span className="h-px w-3.5 rounded-full bg-current" />
                <span className="h-px w-2.5 rounded-full bg-current" />
                <span className="h-px w-3.5 rounded-full bg-current" />
              </span>
            </button>
            {densityOpen && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setDensityOpen(false)} />
                <div className={cn(
                  "absolute top-full z-40 mt-1 w-40 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                  density === "icons" ? "left-0" : "right-0",
                )}>
                  {(["comfortable", "compact", "icons"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setDensity(option)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] capitalize hover:bg-raised/70",
                        density === option ? "text-accent" : "text-ink",
                      )}
                    >
                      {option === "icons" ? "Avatars only" : option}
                      {density === option && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label={remoteClient ? "New" : "New or share"}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={remoteClient ? "New" : "New or share"}
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div className={cn(
                "absolute top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  New Bot
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  New Channel
                </button>
                {!remoteClient && <>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  title="Private backup of bot setup and conversation text. Files, images, workspace memory and connections are not included."
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {exportingTeam ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <ArrowDownToLine size={16} className="text-ink-secondary" />}
                  {exportingTeam ? "Exporting…" : "Export backup"}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  Teams
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">Archived bots</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
                </>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search */}
      <div className={cn("pt-2 pb-3", density === "icons" ? "hidden" : "px-3")}>
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search"
            aria-label="Search bots and messages"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {matchingBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">Nothing matches “{query}”</div>
          )}
          {unsectionedChief && (
            <div className="mb-1.5">
              <BotListItem
                bot={unsectionedChief}
                density={density}
                onMenu={setMenu}
                onArchive={requestArchive}
                archiveDisabled
              />
            </div>
          )}
          {sectionIds.map((id, index) => {
            const sectionName = userSectionName(id);
            const sectionChiefItems = sectionName
              ? sectionChiefs.filter((bot) => bot.section === sectionName)
              : [];
            const sectionGroupItems =
              id === CHANNELS_SECTION_ID
                ? unsectionedRooms
                : id === BOT_CHATS_SECTION_ID
                  ? botChats
                  : sectionName
                    ? sectionedRooms.filter((group) => group.section === sectionName)
                    : [];
            const sectionBotItems =
              id === PINNED_SECTION_ID
                ? pinnedBots
                : id === BOTS_SECTION_ID
                  ? unsectionedBots
                  : sectionName
                    ? sectionedBots.filter((bot) => bot.section === sectionName)
                    : [];
            const collapsed = sectionCollapsed(id);
            const attention = collapsed
              ? sidebarSectionAttention(
                  [...sectionChiefItems, ...sectionBotItems],
                  sectionGroupItems,
                )
              : undefined;
            return (
              <div
                key={id}
                data-sidebar-section-id={id}
                onDragOver={(event) => updateSectionDropTarget(event, id)}
                onDrop={dropSection}
                className={cn(
                  "flex flex-col gap-0.5",
                  density !== "icons" && index > 0 && "pt-3",
                )}
              >
                {dropTarget?.id === id && dropTarget.place === "before" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
                {density !== "icons" && (
                  <SidebarSectionHeader
                    name={sidebarSectionLabel(id)}
                    collapsed={collapsed}
                    attention={attention}
                    onToggle={layoutInteractive ? () => toggleSection(id) : undefined}
                    reorderable={layoutInteractive && sectionIds.length > 1}
                    dragging={draggingSectionId === id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-openmausbot-sidebar-section", id);
                      event.dataTransfer.setData("text/plain", id);
                      sectionDragRef.current = { from: id, over: null };
                      setDraggingSectionId(id);
                    }}
                    onDragEnd={resetSectionDrag}
                    onMove={(direction) => moveSidebarSection(id, direction)}
                  />
                )}
                {!collapsed && (
                  <>
                    {sectionChiefItems.map((bot) => (
                      <BotListItem
                        key={bot.id}
                        bot={bot}
                        density={density}
                        onMenu={setMenu}
                        onArchive={requestArchive}
                        archiveDisabled
                      />
                    ))}
                    {sectionGroupItems.map((group) => (
                      <GroupListItem
                        key={group.id}
                        group={group}
                        density={density}
                        onMenu={setRoomMenu}
                      />
                    ))}
                    {sectionBotItems.map((bot) => (
                      <BotListItem
                        key={bot.id}
                        bot={bot}
                        density={density}
                        onMenu={setMenu}
                        onArchive={requestArchive}
                        archiveDisabled={activeBotCount <= 1}
                      />
                    ))}
                  </>
                )}
                {dropTarget?.id === id && dropTarget.place === "after" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
              </div>
            );
          })}
          <SearchResults query={query} onLanded={() => setQuery("")} />
        </div>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </p>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", density === "icons" ? "px-2" : "px-3")}>
        {density === "icons" && (
          <>
          <button
            onClick={() => dispatch({ type: "showTeamMap" })}
            aria-label={density === "icons" ? "Team map" : undefined}
            title={density === "icons" ? "Team map" : undefined}
            className={cn(
              "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
              density === "icons" ? "justify-center px-2" : "gap-3 px-3",
              state.activeView === "team-map" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
            )}
          >
            <Network size={20} className={state.activeView === "team-map" ? "text-accent" : "text-ink-secondary"} />
            <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Team map</span>
          </button>
          {!remoteClient && skillRecorderEnabled(state.config) && (
            <button
              onClick={() => dispatch({ type: "showSkillRecorder" })}
              aria-label={density === "icons" ? "Teach a skill" : undefined}
              title={density === "icons" ? "Teach a skill" : undefined}
              className={cn(
                "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
                density === "icons" ? "justify-center px-2" : "gap-3 px-3",
                state.activeView === "skill-recorder" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
              )}
            >
              <Sparkles size={20} className={state.activeView === "skill-recorder" ? "text-accent" : "text-ink-secondary"} />
              <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Teach a skill</span>
            </button>
          )}
          <button
            onClick={() => dispatch({ type: "showRoutines" })}
            aria-label={density === "icons" ? "Automations" : undefined}
            title={density === "icons" ? "Automations" : undefined}
            className={cn(
              "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
              density === "icons" ? "justify-center px-2" : "gap-3 px-3",
              state.activeView === "routines" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
            )}
          >
            <CalendarDays size={20} className={state.activeView === "routines" ? "text-accent" : "text-ink-secondary"} />
            <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Automations</span>
            {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
              <span className="size-2 rounded-full bg-danger" />
            )}
          </button>
          <button
            onClick={() => dispatch({ type: "togglePlugins", open: true })}
            className={cn("flex min-h-10 w-full items-center rounded-xl py-2 text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "gap-3 px-3")}
            aria-label={density === "icons" ? "Connected apps" : undefined}
            title={density === "icons" ? "Connected apps" : undefined}
          >
            <Puzzle size={20} className="text-ink-secondary" />
            <span className={cn("text-[14px] text-ink", density === "icons" && "hidden")}>Connected apps</span>
          </button>
          </>
        )}
        {density === "icons" && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
          />
        )}
          {density !== "icons" && (
          <SidebarMoreMenu
            items={[
              {
                key: "team-map",
                label: "Team map",
                icon: <Network size={18} />,
                active: state.activeView === "team-map",
                onSelect: () => dispatch({ type: "showTeamMap" }),
              },
              ...(!remoteClient && skillRecorderEnabled(state.config)
                ? [
                    {
                      key: "skill-recorder",
                      label: "Teach a skill",
                      icon: <Sparkles size={18} />,
                      active: state.activeView === "skill-recorder",
                      onSelect: () => dispatch({ type: "showSkillRecorder" }),
                    },
                  ]
                : []),
              {
                key: "routines",
                label: "Automations",
                icon: <CalendarDays size={18} />,
                active: state.activeView === "routines",
                // folded away, this dot would otherwise vanish with the row
                attention: state.routineRuns.some(
                  (run) => ["failed", "missed"].includes(run.status) && !run.seenAt,
                ),
                onSelect: () => dispatch({ type: "showRoutines" }),
              },
              {
                key: "plugins",
                label: "Connected apps",
                icon: <Puzzle size={18} />,
                onSelect: () => dispatch({ type: "togglePlugins", open: true }),
              },
            ]}
          />
        )}
        {density === "icons" ? (
          <div className="flex items-center justify-center">
            <button
              onClick={() => dispatch({ type: "toggleAppSettings" })}
              className="flex min-w-0 items-center justify-center rounded-xl px-2 py-2 text-left hover:bg-raised/50"
              aria-label="App settings"
              title={state.config?.profile?.name?.trim() || "App settings"}
            >
              <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            </button>
          </div>
        ) : (
          // The Tools row and the profile row are two different kinds of
          // thing — places to go, versus who you are and what the app is —
          // so they get clear space between them. A hairline lived here
          // briefly and made it worse: full-bleed, it ran within a few pixels
          // of the profile row's rounded hover pill, and the two hover states
          // read as one crowded block rather than two rows.
          <div className="mt-3">
            <SidebarProfileMenu />
          </div>
        )}
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={requestArchive}
          onDelete={(bot) => setConfirm({ kind: "delete", bot })}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        {...(confirm ? botConfirmCopy(confirm.kind, confirm.bot.name) : botConfirmCopy("archive", ""))}
        icon={confirm?.kind === "delete" ? <Trash2 size={18} /> : <Archive size={18} />}
        onCancel={cancelConfirm}
        returnFocusRef={sidebarRef}
        onConfirm={() => {
          if (!confirm) return;
          const { kind, bot } = confirm;
          setConfirm(null);
          if (kind === "archive") void archiveBot(bot);
          else dispatch({ type: "deleteBot", botId: bot.id });
        }}
      />
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => {
            if (!remoteClient) {
              dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } });
              return;
            }
            void api("/api/sidebar-sections", {
              method: "POST",
              body: JSON.stringify({ name: section, botIds: [sectionPicker.botId] }),
            })
              .then(({ bots }) => bots.forEach((bot: Bot) => dispatch({ type: "botPatched", bot })))
              .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
          }}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })}
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } })
          }
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {!remoteClient && archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {!remoteClient && teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback({ error: false, text: `${result.members} ${result.members === 1 ? "bot" : "bots"} added · existing bots and chats kept` });
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
