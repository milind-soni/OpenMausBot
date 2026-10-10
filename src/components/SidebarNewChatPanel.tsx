// "New chat" from the sidebar's "+" menu: a panel over the chat area, beside
// the sidebar, that starts a conversation with any bot in two keystrokes.
// Type a name in "To:", arrow to a row, Enter. The two ways to make someone
// new (a bot, a group chat) sit on top, so the panel is never a dead end.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Plus, Users, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { rankByName } from "@/lib/palette-rank";
import { useShowThreads } from "@/lib/thread-preferences";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";

/** Below this much room beside the sidebar the panel takes the whole width
 * (a phone, or a narrow window with the sidebar open over the chat). */
const MIN_BESIDE_WIDTH = 320;
const PANEL_WIDTH = 360;
/** "Create new bot" and "Create group chat" come before the bots. */
const ACTION_COUNT = 2;

/** Gap between the floating card and the sidebar, and the window's far edge. */
const GAP = 8;
/** The card's top: under the chat header (48px) with a small margin. */
export const FLOATING_TOP = 56;
const MAX_HEIGHT = 480;

/** Where the panel sits: a floating card a small gap from the sidebar's inner
 * edge when there is room, otherwise a sheet across the full window. A
 * right-to-left layout puts the sidebar on the right, so the panel opens to
 * its left. */
export function newChatPanelPlacement(
  sidebar: { left: number; right: number } | null,
  viewportWidth: number,
  rtl = false,
): { left: number; width: number; floating: boolean } {
  const sheet = { left: 0, width: viewportWidth, floating: false };
  if (!sidebar) return sheet;
  const room = rtl ? sidebar.left : viewportWidth - sidebar.right;
  if (room < MIN_BESIDE_WIDTH) return sheet;
  const width = Math.min(PANEL_WIDTH, room - 2 * GAP);
  return { left: rtl ? sidebar.left - GAP - width : sidebar.right + GAP, width, floating: true };
}

/** The floating card hugs its content up to this, then the bot list scrolls. */
export function newChatPanelMaxHeight(viewportHeight: number): number {
  return Math.max(160, Math.min(MAX_HEIGHT, viewportHeight - FLOATING_TOP - 2 * GAP));
}

/** One line under the name: the bot's title, else its description's first line. */
export function newChatSubtext(bot: Pick<Bot, "title" | "description">): string {
  return bot.title?.trim() || bot.description?.trim().split("\n")[0]?.trim() || "";
}

export function SidebarNewChatPanel({
  anchor,
  onClose,
  onNewBot,
  onNewGroup,
  style,
}: {
  /** the sidebar, whose right edge the panel opens against */
  anchor: HTMLElement | null;
  onClose: () => void;
  onNewBot: () => void;
  onNewGroup: () => void;
  /** Electron's no-drag region, so the panel stays clickable over a title bar */
  style?: CSSProperties;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [query, setQuery] = useState("");
  // the first bot, not "Create new bot": Enter right away should start a chat
  const [cursor, setCursor] = useState(ACTION_COUNT);
  const [place, setPlace] = useState(() => newChatPanelPlacement(null, typeof window === "undefined" ? 0 : window.innerWidth));
  const [maxHeight, setMaxHeight] = useState(() => newChatPanelMaxHeight(typeof window === "undefined" ? 0 : window.innerHeight));
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  usePopoverDismiss(true, rootRef, onClose);

  useLayoutEffect(() => {
    const measure = () => setPlace(newChatPanelPlacement(
      anchor ? anchor.getBoundingClientRect() : null,
      window.innerWidth,
      anchor ? getComputedStyle(anchor).direction === "rtl" : false,
    ));
    const measureAll = () => { measure(); setMaxHeight(newChatPanelMaxHeight(window.innerHeight)); };
    measureAll();
    window.addEventListener("resize", measureAll);
    const observer = anchor && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (anchor) observer?.observe(anchor);
    return () => {
      window.removeEventListener("resize", measureAll);
      observer?.disconnect();
    };
  }, [anchor]);

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const bots = rankByName(state.bots.filter((bot) => !bot.hidden), query);
  const actions = [
    { key: "bot", icon: <Plus size={16} />, label: t("sidebar.newChat.createBot"), run: onNewBot },
    { key: "group", icon: <Users size={16} />, label: t("sidebar.newChat.createGroup"), run: onNewGroup },
  ];
  // one cursor over both: the two actions first, then the bots
  const count = actions.length + bots.length;
  // A filter that matches no bot leaves nothing selected, so Enter on a typo
  // never falls through to one of the create actions.
  const selected = cursor < actions.length ? cursor : bots.length ? Math.min(cursor, count - 1) : -1;
  const rowLabel = showThreads ? t("sidebar.newChat.start") : t("sidebar.newChat.open");

  const start = (bot: Bot) => {
    // Simple mode keeps one conversation per bot, so it opens that one.
    dispatch(showThreads ? { type: "newTask", botId: bot.id } : { type: "select", id: bot.id });
    onClose();
  };
  const activate = (index: number) => {
    if (index < actions.length) actions[index]?.run();
    else {
      const bot = bots[index - actions.length];
      if (bot) start(bot);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor(selected < 0 ? 0 : (selected + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(selected < 0 ? actions.length - 1 : (selected - 1 + count) % count);
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      if (selected >= 0) activate(selected);
    }
  };

  const rowClass = (index: number) => cn(
    "flex h-12 w-full items-center gap-3 rounded-2xl px-3 text-start text-[14px] text-ink outline-none focus-visible:bg-raised-hover",
    index === selected && "bg-raised-hover",
  );

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-label={t("sidebar.newChat.title")}
      data-new-chat-panel=""
      data-native-view-overlay=""
      data-floating={place.floating ? "" : undefined}
      onKeyDown={onKeyDown}
      style={{ ...style, left: place.left, width: place.width }}
      className={cn(
        "fixed top-0 z-40 flex animate-panel-in flex-col",
        // A phone or narrow window gets a full-height sheet; beside the
        // sidebar only the To: row and the card are drawn, and the chat shows
        // through around them.
        !place.floating && "bottom-0 border-e border-hairline/40 bg-app shadow-2xl shadow-black/40",
      )}
    >
      <div className={cn(
        "flex h-12 shrink-0 items-center gap-2 px-4",
        // the window's own background, so only the list card reads as raised
        place.floating && "rounded-b-2xl bg-app",
      )}>
        <label htmlFor="new-chat-to" className="shrink-0 text-[14px] text-ink-secondary">{t("sidebar.newChat.to")}</label>
        <input
          id="new-chat-to"
          autoFocus
          dir="auto"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setCursor(actions.length); }}
          placeholder={t("sidebar.newChat.placeholder")}
          aria-label={t("sidebar.newChat.placeholder")}
          aria-controls="new-chat-bots"
          autoComplete="off"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {/* At full width there is no outside to press, so the panel says how to leave. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
          className="-me-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:bg-raised"
        >
          <X size={16} />
        </button>
      </div>
      {/* One list in a floating card: the two create actions, then the bots.
          It hugs its rows up to a cap, then scrolls inside. */}
      <div
        id="new-chat-bots"
        role="list"
        style={{ maxHeight }}
        className="mx-3 mt-2 min-h-0 overflow-y-auto rounded-3xl border border-hairline/60 bg-composer p-1.5 shadow-xl shadow-black/25 [scrollbar-width:thin]"
      >
        {actions.map((action, index) => (
          <div role="listitem" key={action.key}>
            <button
              type="button"
              ref={index === selected ? selectedRef : undefined}
              onClick={action.run}
              onMouseMove={() => setCursor(index)}
              className={rowClass(index)}
            >
              <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised-hover text-ink-secondary">{action.icon}</span>
              <span className="truncate">{action.label}</span>
            </button>
          </div>
        ))}
        {state.bots.every((bot) => bot.hidden) ? (
          <div className="px-3 py-4 text-center text-[13px] text-ink-secondary">{t("sidebar.newChannel.emptyHint")}</div>
        ) : bots.length === 0 ? (
          <div className="px-3 py-4 text-center text-[13px] text-ink-secondary">{t("sidebar.newChat.noMatch", { query: query.trim() })}</div>
        ) : bots.map((bot, i) => {
          // The pointer selects by moving (onMouseMove), so exactly one row is
          // ever lit, whether the keyboard or the mouse put it there.
          const index = actions.length + i;
          const subtext = newChatSubtext(bot);
          return (
            <div role="listitem" key={bot.id}>
              <button
                type="button"
                ref={index === selected ? selectedRef : undefined}
                onClick={() => start(bot)}
                // mousemove, not mouseenter: a list scrolling under a resting
                // pointer must not steal the keyboard selection
                onMouseMove={() => setCursor(index)}
                aria-label={`${bot.name}${subtext ? `, ${subtext}` : ""}. ${rowLabel}`}
                title={subtext || undefined}
                className={rowClass(index)}
              >
                <BotAvatar bot={bot} state="happy" size={32} />
                <span dir="auto" className="min-w-0 flex-1 truncate">{bot.name}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
