import { useEffect, useRef, useState } from "react";
import { Hand, Loader2, Minimize2, RefreshCw, Send } from "lucide-react";
import type RFB from "@novnc/novnc";
import { cn } from "@/lib/cn";
import { connectDesktop, typeOnDesktop } from "@/lib/desktop-connection";
import { t } from "@/lib/i18n";
import { useCaptionChrome, useDesktopCapabilities } from "./DesktopCapabilities";

type Connection = "connecting" | "connected" | "disconnected";

/** The computer the person took control of, live and drivable where they were watching it. */
export function LiveDesktop({ target, threadId, name, poster, expanded, onExpandedChange, onHandBack, handingBack, onUnreachable }: {
  target: string;
  threadId: string;
  name: string;
  /** The last watched frame, shown until the first live one arrives. */
  poster: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onHandBack: () => void;
  handingBack: boolean;
  /** The desktop never came up, so the person cannot drive it. */
  onUnreachable: () => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [text, setText] = useState("");
  const live = useRef(false);
  const { dragProps, noDragStyle, padClass } = useCaptionChrome();
  const macInset = useDesktopCapabilities().capabilities.windowChrome === "mac-inset";
  const unreachable = useRef(onUnreachable);
  unreachable.current = onUnreachable;

  useEffect(() => {
    const controller = new AbortController();
    let client: RFB | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const lost = () => {
      setConnection("disconnected");
      if (!live.current) unreachable.current();
      else if (attempt === 0) retry = setTimeout(() => setAttempt(1), 1_000);
    };
    setConnection("connecting");
    void connectDesktop(screen.current!, target, {
      threadId,
      signal: controller.signal,
      events: {
        connected: () => {
          live.current = true;
          setConnection("connected");
        },
        disconnected: lost,
      },
    }).then((connected) => {
      if (controller.signal.aborted) return connected.disconnect();
      client = connected;
      rfb.current = connected;
    }, () => { if (!controller.signal.aborted) lost(); });
    return () => {
      controller.abort();
      clearTimeout(retry);
      client?.disconnect();
      if (rfb.current === client) rfb.current = null;
    };
  }, [target, threadId, attempt]);

  useEffect(() => {
    if (connection === "connected") rfb.current?.focus({ preventScroll: true });
  }, [expanded, connection]);

  const label = t("computer.viewerTitle", { name });
  const pill = (
    <span className="pointer-events-none flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
      <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
      {t("computer.inControl")}
    </span>
  );
  const iconButton = "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

  return (
    <div
      data-live-desktop
      data-state={connection}
      data-expanded={expanded ? "true" : undefined}
      className={cn(expanded ? "fixed inset-0 z-[65] flex flex-col bg-app" : "relative h-full w-full")}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape" && !(event.target instanceof HTMLCanvasElement)) onExpandedChange(false);
      }}
    >
      {expanded && (
        <header {...dragProps} className={cn("flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/40 bg-panel px-3 py-2", macInset && "pl-[86px]", padClass)}>
          <span className="min-w-0 truncate text-[13px] font-medium text-ink">{label}</span>
          {pill}
          <form
            style={noDragStyle}
            className="ml-auto flex min-w-0 items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!rfb.current || connection !== "connected" || !text) return;
              typeOnDesktop(rfb.current, text);
              setText("");
            }}
          >
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={4096}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t("desktopViewer.text")}
              aria-label={t("desktopViewer.text")}
              className="w-44 min-w-0 rounded-lg border border-hairline bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-focus max-sm:w-28"
            />
            <button type="submit" disabled={connection !== "connected" || !text} title={t("desktopViewer.send")} aria-label={t("desktopViewer.send")} className={cn(iconButton, "bg-control text-ink hover:bg-raised-hover")}>
              <Send size={14} aria-hidden="true" />
            </button>
          </form>
          <button type="button" style={noDragStyle} onClick={() => onExpandedChange(false)} className={cn(iconButton, "bg-control text-ink hover:bg-raised-hover")}>
            <Minimize2 size={14} aria-hidden="true" />
            <span className="max-sm:hidden">{t("desktopViewer.exitFullscreen")}</span>
          </button>
          <button type="button" style={noDragStyle} onClick={onHandBack} disabled={handingBack} className={cn(iconButton, "bg-accent font-medium text-accent-ink hover:brightness-110")}>
            {handingBack ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Hand size={14} aria-hidden="true" />}
            {t("computer.handBack")}
          </button>
        </header>
      )}
      <div className={cn("relative overflow-hidden bg-inset", expanded ? "min-h-0 flex-1" : "h-full w-full")}>
        {poster && connection !== "connected" && (
          <img src={poster} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-contain opacity-50" />
        )}
        <div ref={screen} role="application" aria-label={label} className="absolute inset-0" />
        {connection === "connecting" && (
          <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-[12px] text-ink-secondary">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            {t("desktopViewer.connecting")}
          </div>
        )}
        {connection === "disconnected" && (
          <div role="alert" className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-card/95 p-3 text-center text-[12px] text-ink-secondary">
            <span>{t("desktopViewer.disconnected")}</span>
            <button type="button" onClick={() => setAttempt((value) => value + 1)} className="flex items-center gap-1.5 rounded-md bg-control px-3 py-1.5 text-ink hover:bg-raised-hover">
              <RefreshCw size={13} aria-hidden="true" />
              {t("desktopViewer.reconnect")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
