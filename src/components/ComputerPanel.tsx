import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  Loader2,
  Monitor,
  Power,
  Settings,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { usePanelResize } from "@/lib/usePanelResize";
import { ResizeHandle } from "./ResizeHandle";

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const triggerRef = useRef<HTMLElement | null>(null);

  const { width: computerWidth, handleProps: computerHandleProps } = usePanelResize({
    id: "settings",
    defaultWidth: 400,
    minWidth: 320,
    maxWidth: 560,
    edge: "left",
    label: "Resize computer panel",
    docked: true,
  });

  const resolveAndRestoreFocus = useCallback(() => {
    // When Computer panel closes, header width changes and useHeaderCollapse
    // reflows the header (mounting or unmounting direct button vs More menu).
    // Try immediate focus, and retry on next frame so reflowed header is resolved.
    const tryFocus = () => {
      // 1. Direct computer button
      const directBtn = document.querySelector<HTMLElement>('button[data-invoker="computer"]');
      if (directBtn && directBtn.offsetParent !== null) {
        directBtn.focus();
        return true;
      }
      // 2. More actions trigger button
      const moreBtn = document.querySelector<HTMLElement>(
        'button[data-invoker="more-actions"], button[aria-label="More actions"]',
      );
      if (moreBtn && moreBtn.offsetParent !== null) {
        moreBtn.focus();
        return true;
      }
      // 3. Captured trigger if still in DOM
      if (triggerRef.current && triggerRef.current.isConnected) {
        triggerRef.current.focus();
        return true;
      }
      // 4. Header name / fallback
      const fallback = document.querySelector<HTMLElement>(
        'main button[title="Bot settings"], main header button, main header',
      );
      if (fallback) {
        fallback.focus();
        return true;
      }
      return false;
    };

    if (!tryFocus()) {
      requestAnimationFrame(() => {
        if (!tryFocus()) {
          setTimeout(tryFocus, 50);
        }
      });
    }
  }, []);

  const handleClose = useCallback(() => {
    dispatch({ type: "toggleComputer", open: false });
    resolveAndRestoreFocus();
  }, [dispatch, resolveAndRestoreFocus]);

  useEffect(() => {
    triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleClose]);

  const localShort = "this computer";
  const localLong = "This computer";
  const phase = bot.computer === "off" ? "off" : window.gbs ? "local" : "local-unavailable";
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  useEffect(() => { setLocalFrame(null); }, [bot.id, bot.computer]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (phase !== "local" || !window.gbs) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.gbs!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    const timer = setInterval(shoot, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, bot.id]);

  const frameSrc = phase === "local" ? localFrame : null;

  return (
    <aside
      data-panel="settings"
      data-docked="true"
      className="animate-panel-in relative z-30 flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel"
      style={{ width: `${computerWidth}px` }}
    >
      <ResizeHandle {...computerHandleProps} />
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Bot settings"
        >
          <Settings size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Computer</span>
        <button
          onClick={handleClose}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label="Close computer panel"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {/* Screen preview */}
        <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
          <span>{bot.name}'s screen</span>
          {phase === "local" && <span className="text-[11px]">{localShort}</span>}
        </div>
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc ? (
            <img src={frameSrc} alt={`${bot.name}'s screen`} className="h-full w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "local" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "local"
                    ? localMisses >= 3
                      ? "Screen preview needs Screen Recording permission. Allow it in Settings, then reopen the app."
                      : `Capturing ${localShort}'s screen…`
                    : phase === "off" ? "This bot’s computer is off" : "Open the desktop app to use this computer"}
              </span>
              {phase === "local" && localMisses >= 3 && (
                <button
                  onClick={() => window.gbs?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
            </div>
          )}
        </div>

        {/* Computer source */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Runs on</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Allow this bot to use this computer in the desktop app.
          </div>
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["local", localLong],
                ["off", "Off"],
              ] as const
            ).map(([mode, label], i) => (
              <button
                key={mode}
                disabled={mode === "local" && !window.gbs}
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } })}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  (bot.computer ?? "local") === mode
                    ? "bg-raised text-ink"
                    : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Routines */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <CalendarClock size={16} className="text-ink-secondary" />
            Routines
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Routines are recurring tasks this agent runs on a schedule.
          </div>
          <button
            disabled
            className="mt-3 w-full cursor-not-allowed rounded-lg bg-raised py-2 text-[13px] text-ink-secondary opacity-60"
            title="Coming soon"
          >
            Create Routine
          </button>
        </div>
      </div>
    </aside>
  );
}
