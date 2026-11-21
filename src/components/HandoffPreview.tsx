import { useEffect, useRef, useState } from "react";
import { Hand, Loader2, Monitor } from "lucide-react";

import type { Surface } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { usePageVisible } from "@/lib/page-visible";
import { browserStreamAccess, createPreviewFramePainter, createPreviewStreamClient } from "@/lib/browser-stream-client";
import { browserScope } from "@/lib/team-browser";
import { api } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

/** What the card shows of the place while it waits: the live page, the newest frame, or that it is connecting. */
export type PreviewPhase = "connecting" | "live" | "frame" | "none";

/**
 * The place a handoff names, live at the card's width: the bot's browser as a watch-only stream (it neither sizes the
 * page nor takes control), else the newest screen frame the bot's work sent. The whole picture is the Take over button.
 */
export function HandoffPreview({ botId, threadId, place, label, onOpen, disabled = false, still }: {
  botId: string;
  threadId: string;
  place: Surface;
  /** The button's name for screen readers: what pressing it does. */
  label: string;
  onOpen: () => void;
  disabled?: boolean;
  /** A fixed picture instead of a live one (previews of the card itself). */
  still?: string | null;
}) {
  const visible = usePageVisible();
  const streams = useStoreSelector((state) => state.config?.browserEngine?.engine === "chrome");
  const team = useStoreSelector((state) => state.config?.team);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<PreviewPhase>(still ? "frame" : "connecting");
  const [frame, setFrame] = useState<string | null>(still ?? null);
  const live = still === undefined && place === "browser" && streams;
  // The Browser panel open on this bot has its own stream: the card keeps its last picture rather than open a second.
  const panelOpen = useStoreSelector((state) => state.computerOpen && state.selectedId === botId);
  const streaming = live && visible && !panelOpen;

  useEffect(() => {
    if (!streaming || !canvas.current) return;
    const painter = createPreviewFramePainter(canvas.current, () => setPhase("live"));
    const client = createPreviewStreamClient(
      { access: browserStreamAccess(botId, window.location, browserScope(team, threadId)), maxWidth: 1120, maxHeight: 700, interactive: false },
      { onFrame: (jpeg) => painter.paint(jpeg), onViewport: () => undefined, onConnectedChange: () => undefined, onUnauthorized: () => setPhase((now) => (now === "live" ? now : "none")) },
    );
    return () => { client.stop(); painter.stop(); };
  }, [streaming, botId, threadId, team]);

  const seen = useStoreSelector((state) => {
    const row = state.bots.find((bot) => bot.id === botId)?.messages.findLast((one) => one.kind === "screen" && one.png);
    return row?.png ? `data:${row.mime ?? "image/png"};base64,${row.png}` : null;
  });
  useEffect(() => {
    if (live || still !== undefined || !seen) return;
    setFrame((now) => now ?? seen);
    setPhase((now) => (now === "connecting" || now === "none" ? "frame" : now));
  }, [live, still, seen]);
  useEffect(() => {
    if (live || still !== undefined || place !== "cloud") return;
    const controller = new AbortController();
    api(`/api/bots/${encodeURIComponent(botId)}/computer/screenshot?threadId=${encodeURIComponent(threadId)}`, { method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
      .then(({ png, format }: { png?: unknown; format?: unknown }) => {
        if (typeof png !== "string" || !png) return;
        setFrame(`data:${format === "jpeg" ? "image/jpeg" : "image/png"};base64,${png}`);
        setPhase("frame");
      }, () => undefined);
    return () => controller.abort();
  }, [live, still, place, botId, threadId]);

  useEffect(() => {
    if (live || still !== undefined) return;
    const surface = place === "browser" ? "browser" : "computer";
    const stop = listenLiveFrames({ screens: true, onFrame: (next) => {
      if (next.kind !== "screen" || next.botId !== botId || next.threadId !== threadId || (next.surface && next.surface !== surface)) return;
      setFrame(`data:${next.mime ?? "image/png"};base64,${next.png}`);
      setPhase("frame");
    } });
    const settle = setTimeout(() => setPhase((now) => (now === "connecting" ? "none" : now)), 8_000);
    return () => { stop(); clearTimeout(settle); };
  }, [live, still, place, botId, threadId]);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-label={label}
      data-preview-phase={phase}
      className="group relative block aspect-[16/10] w-full overflow-hidden bg-black text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-wait"
    >
      {live && <canvas ref={canvas} aria-hidden="true" className={cn("absolute inset-0 h-full w-full object-contain", phase !== "live" && "opacity-0")} />}
      {!live && frame && <img src={frame} alt="" className="absolute inset-0 h-full w-full object-contain" />}
      {live && !streaming && phase !== "live" ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px] text-white/70">
          <Monitor size={20} aria-hidden="true" />{t(panelOpen ? "handoff.inPanel" : "handoff.noPicture")}
        </span>
      ) : (phase === "connecting" || phase === "none") && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px] text-white/70">
          {phase === "connecting"
            ? <><Loader2 size={18} aria-hidden="true" className="motion-safe:animate-spin" />{t("handoff.connecting")}</>
            : <><Monitor size={20} aria-hidden="true" />{t("handoff.noPicture")}</>}
        </span>
      )}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-[opacity,background-color] duration-[120ms] ease-out group-hover:bg-black/40 group-hover:opacity-100 group-focus-within:bg-black/40 group-focus-within:opacity-100 touch:opacity-100 motion-reduce:transition-none">
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-black/70 px-3 text-[13px] font-medium text-white">
          <Hand size={14} />{t("handoff.takeOver")}
        </span>
      </span>
    </button>
  );
}
