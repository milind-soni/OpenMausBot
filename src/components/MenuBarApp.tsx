import { useEffect, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useStore, formatTime, visibleMessages, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ChatView } from "./ChatView";
import { stateForBot } from "@/lib/mascot";
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
  const [creating, setCreating] = useState(false);
  const selectedRef = useRef(state.selectedId);
  const bots = state.bots.filter((bot) => !bot.hidden);
  const bot = bots.find((candidate) => candidate.id === state.selectedId) ?? bots[0];

  useEffect(() => {
    if (creating && state.selectedId && state.selectedId !== selectedRef.current) {
      setChatOpen(true);
      setCreating(false);
    }
    selectedRef.current = state.selectedId;
  }, [creating, state.selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (chatOpen) {
        setChatOpen(false);
        return;
      }
      void window.ogb?.menuBar?.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen]);

  const openMain = () => {
    void window.ogb?.menuBar?.openMain();
  };

  if (!state.connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-app text-ink-secondary">
        <Loader2 size={18} className="animate-spin" />
        <div className="text-[13px]">Connecting…</div>
      </div>
    );
  }

  if (chatOpen && bot) {
    return (
      <div className="flex h-full flex-col bg-app">
        <ChatView
          bot={bot}
          compact
          onBack={() => setChatOpen(false)}
          onExpand={openMain}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-app text-ink">
      <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
        <div>
          <div className="text-[15px] font-semibold">OpenMausBot</div>
          <div className="mt-0.5 text-[12px] text-ink-secondary">
            {bots.length === 1 ? "1 bot" : `${bots.length} bots`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            dispatch({ type: "newBot" });
          }}
          disabled={creating}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          title="New bot"
          aria-label="Create a new bot"
        >
          {creating ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} strokeWidth={2} />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {bots.length === 0 && (
          <div className="px-3 py-8 text-center text-[13px] text-ink-secondary">
            No bots yet — tap + to create one.
          </div>
        )}
        {bots.map((row) => {
          const preview = lastLine(row);
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => {
                dispatch({ type: "select", id: row.id });
                setChatOpen(true);
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-raised/60",
                row.id === bot?.id && chatOpen && "bg-raised",
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
                <span className="shrink-0 text-[11px] text-ink-secondary">
                  {formatTime(row.messages.at(-1)!.at)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-hairline/40 px-2 py-1.5">
        <button
          type="button"
          onClick={openMain}
          className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Open full app
        </button>
        <button
          type="button"
          onClick={() => void window.ogb?.menuBar?.hide()}
          className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Hide
        </button>
      </div>
    </div>
  );
}
