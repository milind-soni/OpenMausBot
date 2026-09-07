import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BookOpen, X } from "lucide-react";

import { BotAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import type { Bot } from "@/state/store";

export function BotInstructionsDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(() => onCloseRef.current(), []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [close]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-instructions-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div className="flex min-w-0 items-center gap-3">
            <BotAvatar
              bot={bot}
              state={normalizeState(bot.mascotExpression) ?? "idle"}
              size={38}
              motion="none"
              motionKey={0}
              animated={false}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-accent-text">
                <BookOpen size={15} />
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">Bot instructions</span>
              </div>
              <h2 id="bot-instructions-title" className="mt-0.5 truncate text-[20px] font-semibold tracking-[-0.01em] text-ink">
                {bot.name}
              </h2>
              {bot.title && <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close bot instructions"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={19} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8 sm:py-6">
          {bot.description.trim() ? (
            <div className="whitespace-pre-wrap break-words rounded-xl border border-hairline/50 bg-inset px-4 py-4 text-[13.5px] leading-6 text-ink">
              {bot.description}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-hairline bg-inset px-5 py-12 text-center">
              <BookOpen size={22} className="mx-auto text-ink-secondary/60" />
              <p className="mt-3 text-[13px] font-medium text-ink">No instructions yet</p>
              <p className="mt-1 text-[12px] text-ink-secondary">Add them from this bot’s profile.</p>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-hairline/40 px-6 py-4 text-[11.5px] text-ink-secondary sm:px-8">
          <span>Included in this bot’s context on every turn.</span>
          <button type="button" onClick={close} className="rounded-lg bg-control px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover">
            Done
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
