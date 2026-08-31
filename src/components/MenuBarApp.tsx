import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bot as BotIcon, ChevronLeft, Loader2, Plus, Search } from "lucide-react";
import { api, useStore, formatTime, visibleMessages, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ChatView } from "./ChatView";
import { CommandPalette } from "./CommandPalette";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { stateForBot } from "@/lib/mascot";
import { archiveBlockedReason } from "@/lib/bot-archive";
import { menuBarBotMatches } from "@/lib/menu-bar-search";
import { cn } from "@/lib/cn";

function lastLine(bot: Bot): string {
  const messages = visibleMessages(bot);
  const last = messages[messages.length - 1];
  if (bot.busy) return "Working…";
  if (!last) return bot.title || bot.description || "";
  const text = last.text?.trim() ?? "";
  if (!text) return last.role === "user" ? "You sent a message" : "New activity";
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

export function MenuBarApp() {
  const { state, dispatch } = useStore();
  const [chatOpen, setChatOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [query, setQuery] = useState("");
  const [openAfterSearch, setOpenAfterSearch] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string; restoreId?: string } | null>(null);
  const selectedRef = useRef(state.selectedId);
  const bots = state.bots.filter((bot) => !bot.hidden);
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const bot = bots.find((candidate) => candidate.id === state.selectedId);
  const visible = useMemo(
    () => bots.filter((row) => menuBarBotMatches(row, query, lastLine(row))),
    [bots, query],
  );
  const rosterLocked = Boolean(busyId) || restoringAll;

  useEffect(() => {
    if (creating && state.selectedId && state.selectedId !== selectedRef.current) {
      setChatOpen(true);
      setCreating(false);
    }
    selectedRef.current = state.selectedId;
  }, [creating, state.selectedId]);

  useEffect(() => {
    if (!openAfterSearch) return;
    setOpenAfterSearch(false);
    setQuery("");
    if (bots.some((row) => row.id === state.selectedId)) setChatOpen(true);
    else void window.ogb?.menuBar?.openMain();
  }, [openAfterSearch, bots, state.selectedId]);

  useEffect(() => {
    if (archivedOpen && archivedBots.length === 0) setArchivedOpen(false);
  }, [archivedOpen, archivedBots.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        if (event.target.value) return;
      }
      if (plusOpen) {
        setPlusOpen(false);
        return;
      }
      if (chatOpen) {
        setChatOpen(false);
        return;
      }
      if (archivedOpen) {
        setArchivedOpen(false);
        return;
      }
      void window.ogb?.menuBar?.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [archivedOpen, chatOpen, plusOpen]);

  const openMain = () => {
    void window.ogb?.menuBar?.openMain();
  };

  const createBot = () => {
    setArchivedOpen(false);
    setNotice(null);
    setCreating(true);
    dispatch({ type: "newBot" });
  };

  const archiveBot = async (row: Bot) => {
    const reason = archiveBlockedReason(row, bots.length);
    if (reason || rosterLocked) return;
    setBusyId(row.id);
    setNotice(null);
    try {
      const response = await api(`/api/bots/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === row.id) {
        const next = bots.find((candidate) => candidate.id !== row.id);
        if (next) dispatch({ type: "select", id: next.id });
        setChatOpen(false);
      }
      setNotice({ error: false, text: `${row.name} archived`, restoreId: row.id });
    } catch (cause) {
      setNotice({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusyId(null);
    }
  };

  const restoreBot = async (row: Bot) => {
    if (rosterLocked) return;
    setBusyId(row.id);
    setNotice(null);
    try {
      const response = await api(`/api/bots/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: row.id });
      setNotice({ error: false, text: `${row.name} restored` });
      if (archivedBots.length <= 1) setArchivedOpen(false);
    } catch (cause) {
      setNotice({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    if (rosterLocked || archivedBots.length === 0) return;
    setRestoringAll(true);
    setNotice(null);
    try {
      const responses = await Promise.all(
        archivedBots.map((row) =>
          api(`/api/bots/${row.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = archivedBots[0];
      if (first) dispatch({ type: "select", id: first.id });
      setNotice({
        error: false,
        text: `${archivedBots.length} ${archivedBots.length === 1 ? "bot" : "bots"} restored`,
      });
      setArchivedOpen(false);
    } catch (cause) {
      setNotice({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setRestoringAll(false);
    }
  };

  const undoArchive = async (id?: string) => {
    if (!id) return;
    const row = state.bots.find((candidate) => candidate.id === id);
    if (!row) return;
    await restoreBot(row);
  };

  if (!state.connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-app text-ink-secondary">
        <Loader2 size={18} className="animate-spin" />
        <div className="text-[13px]">Connecting…</div>
      </div>
    );
  }

  const looking = query.trim();

  return (
    <div className="flex h-full flex-col bg-app text-ink">
      <CommandPalette onActivate={() => setOpenAfterSearch(true)} />
      {chatOpen && bot ? (
        <ChatView
          bot={bot}
          compact
          onBack={() => setChatOpen(false)}
          onExpand={openMain}
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
            <div className="flex min-w-0 items-start gap-2">
              {archivedOpen && (
                <button
                  type="button"
                  onClick={() => setArchivedOpen(false)}
                  disabled={rosterLocked}
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                  title="Back to bots"
                  aria-label="Back to bot list"
                >
                  <ChevronLeft size={18} />
                </button>
              )}
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">{archivedOpen ? "Archived bots" : "OpenMausBot"}</div>
                <div className="mt-0.5 text-[12px] text-ink-secondary">
                  {archivedOpen
                    ? `${archivedBots.length} archived`
                    : bots.length === 1
                      ? "1 bot"
                      : `${bots.length} bots`}
                </div>
              </div>
            </div>
            <div className="relative flex shrink-0 items-center gap-0.5">
              {archivedOpen ? (
                archivedBots.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void restoreAll()}
                    disabled={rosterLocked}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                  >
                    {restoringAll && <Loader2 size={13} className="animate-spin" />}
                    Restore all
                  </button>
                )
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setPlusOpen((open) => !open)}
                    disabled={creating}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                    title="New or share"
                    aria-label="New or share"
                    aria-expanded={plusOpen}
                  >
                    {creating ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} strokeWidth={2} />}
                  </button>
                  {plusOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
                      <div className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
                        <button
                          type="button"
                          onClick={() => {
                            setPlusOpen(false);
                            createBot();
                          }}
                          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                        >
                          <BotIcon size={16} className="text-ink-secondary" />
                          New Bot
                        </button>
                        {archivedBots.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setPlusOpen(false);
                              setQuery("");
                              setArchivedOpen(true);
                            }}
                            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                          >
                            <Archive size={16} className="text-ink-secondary" />
                            <span className="flex-1">Archived bots</span>
                            <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          {!archivedOpen && (
            <div className="px-3 pb-2">
              <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
                <Search size={16} className="text-ink-secondary" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    if (!looking) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  }}
                  placeholder="Search"
                  aria-label="Search bots and messages"
                  className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
                />
              </div>
            </div>
          )}
          {notice && (
            <div
              role={notice.error ? "alert" : "status"}
              className={cn(
                "mx-3 mb-2 rounded-lg px-3 py-2 text-[12.5px]",
                notice.error ? "bg-danger/10 text-danger" : "bg-raised/70 text-ink-secondary",
              )}
            >
              <span>{notice.text}</span>
              {notice.restoreId ? (
                <button
                  type="button"
                  onClick={() => void undoArchive(notice.restoreId)}
                  disabled={rosterLocked}
                  className="ml-2 font-medium text-ink hover:underline disabled:opacity-40"
                >
                  Undo
                </button>
              ) : null}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {archivedOpen ? (
              archivedBots.map((row) => (
                <div key={row.id} className="flex items-center gap-3 rounded-xl px-2.5 py-2">
                  <BotAvatar bot={row} state="happy" size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{row.name}</div>
                    <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{row.title || "Bot"}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void restoreBot(row)}
                    disabled={rosterLocked}
                    className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                  >
                    {busyId === row.id && <Loader2 size={13} className="animate-spin" />}
                    Restore
                  </button>
                </div>
              ))
            ) : (
              <>
                {bots.length === 0 && !looking && (
                  <div className="px-3 py-8 text-center text-[13px] text-ink-secondary">
                    No bots yet — tap + to create one.
                  </div>
                )}
                {visible.length === 0 && looking && looking.length < MIN_QUERY && (
                  <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
                    Nothing matches “{query}”
                  </div>
                )}
                {visible.map((row) => {
                  const preview = lastLine(row);
                  const blocked = archiveBlockedReason(row, bots.length);
                  return (
                    <div key={row.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => {
                          dispatch({ type: "select", id: row.id });
                          setQuery("");
                          setChatOpen(true);
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl py-2 pl-2.5 pr-11 text-left hover:bg-raised/60",
                          row.id === bot?.id && "bg-raised/40",
                        )}
                      >
                        <BotAvatar
                          bot={row}
                          state={stateForBot({ ...row, messages: visibleMessages(row) })}
                          size={36}
                          animated={Boolean(row.busy) || Boolean(row.unread)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-semibold">{row.name}</span>
                            <span
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                row.busy ? "animate-pulse bg-warning" : row.unread ? "bg-accent" : "bg-success",
                              )}
                            />
                          </div>
                          <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{preview}</div>
                        </div>
                        {row.messages.at(-1)?.at ? (
                          <span className="shrink-0 text-[11px] text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                            {formatTime(row.messages.at(-1)!.at)}
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(blocked) || rosterLocked}
                        onClick={() => void archiveBot(row)}
                        aria-label={`Archive ${row.name}`}
                        title={blocked ?? `Archive ${row.name}`}
                        className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        {busyId === row.id ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
                      </button>
                    </div>
                  );
                })}
                <SearchResults query={query} onLanded={() => setOpenAfterSearch(true)} />
              </>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-hairline/40 px-2 py-1.5">
            <button
              type="button"
              onClick={openMain}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Open full app
            </button>
            {!archivedOpen && archivedBots.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setArchivedOpen(true);
                }}
                className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Archived ({archivedBots.length})
              </button>
            )}
            <button
              type="button"
              onClick={() => void window.ogb?.menuBar?.hide()}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Hide
            </button>
          </div>
        </>
      )}
    </div>
  );
}
