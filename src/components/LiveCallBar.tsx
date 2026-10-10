// The Live call bar: above the composer of the chat the call belongs to, so
// the person watches the bot work while they talk. The call itself (media)
// lives app-wide in src/lib/live-call-media.ts; this is only its face.
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Mic, MicOff, PhoneOff, RotateCcw, Settings, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import {
  dismissLiveNotice, hangUpLiveCall, isLiveCallRunning, liveCallChord, setLiveMuted, takeLiveCallAction, useLiveMedia,
  type LiveCallAction, type LiveMediaState,
} from "@/lib/live-call-media";
import { api, liveCallFromFrame, nextLiveCallLookup, useStore, type Action, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import type { LiveCallState, LiveClient } from "../../shared/wire";
import { LiveCallSettings } from "./LiveCallSettings";

export type LiveCallBarView =
  /** `hint`: a note while the call runs (the window blocked its audio) */
  | { kind: "local"; title: string; caption: string; heard: string; muted: boolean; ending: boolean; hint: string | null }
  /** a phone (or another window) holds this bot's call */
  | { kind: "remote"; title: string; callId: string }
  /** `action`: the one thing that helps, if anything does */
  | { kind: "notice"; text: string; action: LiveCallAction | null };

const DEVICE_KEY = {
  ios: "call.live.device.ios",
  android: "call.live.device.android",
  desktop: "call.live.device.desktop",
  web: "call.live.device.web",
} as const satisfies Record<LiveClient, string>;

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Pure: what the bar shows for this chat. */
export function liveCallBarView({ bot, media, server, now }: {
  bot: { id: string; threadId: string; name: string };
  media: LiveMediaState;
  server: LiveCallState | null;
  now: number;
}): LiveCallBarView | null {
  const here = media.botId === bot.id && media.threadId === bot.threadId;
  if (here && (media.phase === "failed" || media.phase === "ended") && media.notice) {
    return { kind: "notice", text: media.notice, action: media.phase === "failed" ? media.action : null };
  }
  if (here && isLiveCallRunning(media.phase)) {
    // the clock runs from the moment the call went live, also while it ends
    const when = media.startedAt !== null ? clock(now - media.startedAt) : t("call.live.connecting");
    return {
      kind: "local",
      // after this window's Hang up, until the computer confirms the end (as
      // on the iPhone); an end nobody here asked for keeps the call's title
      title: media.hangingUp ? t("call.live.hangingUp") : `${t("call.live.with", { name: bot.name })} · ${when}`,
      caption: media.caption,
      heard: media.heard,
      muted: media.muted,
      ending: media.phase === "ending",
      hint: media.notice,
    };
  }
  // Not "ending": a call this window just hung up is briefly still ending on
  // the harness after the media module let go of it, and a call another
  // device hangs up has nothing left to hang up. A status this window does
  // not know counts as running, so the bar (and its Hang up) stays.
  if (
    server && server.status !== "ending" && server.status !== "ended"
    && server.botId === bot.id && server.threadId === bot.threadId && server.callId !== media.callId
  ) {
    return { kind: "remote", title: t("call.live.onPhone", { name: bot.name, device: t(DEVICE_KEY[server.client]) }), callId: server.callId };
  }
  return null;
}

/** Whether another device (a phone, another window) holds the one Live
 * line while this window holds no call: a call button that would start a
 * Live call is hidden then, as on the iPhone (Take turns stays). Any status
 * but "ended" holds the line. */
export function liveLineHeldElsewhere(media: LiveMediaState, server: LiveCallState | null): boolean {
  return Boolean(server && server.status !== "ended") && !isLiveCallRunning(media.phase);
}

/** Hang up a call another device holds. If the harness no longer knows it
 * (this bar missed the end frame), take its real state so the bar goes —
 * unless a live.call frame newer than `since` (the store's
 * liveCallVersion when the button was pressed) lands meanwhile. */
export async function hangUpRemoteCall(
  callId: string,
  since: number,
  dispatch: (action: Action) => void,
  request: typeof api = api,
): Promise<void> {
  try {
    await request("/api/live/call/end", { method: "POST", body: JSON.stringify({ callId }) });
  } catch {
    try {
      const seq = nextLiveCallLookup();
      const answer = liveCallFromFrame(await request<unknown>("/api/live/call"));
      if (answer) dispatch({ type: "liveCallLookup", call: answer.call, since, seq });
    } catch {
      /* offline: the next connection refreshes the call */
    }
  }
}

export function LiveCallBar({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const media = useLiveMedia();
  const [now, setNow] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const view = liveCallBarView({ bot, media, server: state.liveCall, now });
  const kind = view?.kind;

  useEffect(() => {
    if (kind !== "local") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [kind]);

  useEffect(() => {
    if (kind !== "local") setSettingsOpen(false);
  }, [kind]);

  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [settingsOpen]);

  if (!view) return null;
  const button = "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors";
  // lines up with the composer below it. The composer dock lets clicks
  // through to the transcript; the bar itself takes them.
  const frame = "pointer-events-auto mx-5 mb-2 flex items-center rounded-xl border bg-panel px-3 py-2 text-[12.5px] text-ink";

  if (view.kind === "notice") {
    const action = view.action === "open-in-browser"
      ? { label: t("call.live.openInBrowser"), Icon: ExternalLink }
      : view.action === "retry" ? { label: t("call.live.tryAgain"), Icon: RotateCcw } : null;
    return (
      <div role="status" className={cn(frame, "gap-2 border-hairline/60")}>
        <span className="min-w-0 flex-1 truncate" title={view.text}>{view.text}</span>
        {action && (
          <button type="button" aria-label={action.label} className={cn(button, "bg-raised hover:bg-raised-hover")} onClick={takeLiveCallAction}>
            <action.Icon className="size-3.5" /> <span className="hidden sm:inline">{action.label}</span>
          </button>
        )}
        <button type="button" aria-label={t("call.live.close")} className={cn(button, "text-ink-secondary hover:text-ink")} onClick={dismissLiveNotice}>
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  if (view.kind === "remote") {
    const callId = view.callId;
    return (
      <div role="status" className={cn(frame, "gap-2 border-success/40")}>
        <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{view.title}</span>
        <button
          type="button"
          aria-label={t("call.live.hangUp")}
          className={cn(button, "bg-danger text-white hover:brightness-110")}
          onClick={() => void hangUpRemoteCall(callId, state.liveCallVersion, dispatch)}
        >
          <PhoneOff className="size-3.5" /> <span className="hidden sm:inline">{t("call.live.hangUp")}</span>
        </button>
      </div>
    );
  }

  const spoken = view.heard || view.caption;
  const isMac = isMacPlatform();
  const muteLabel = view.muted ? t("call.live.unmute") : t("call.live.mute");
  const muteChord = liveCallChord("mute", isMac);
  const hangUpChord = liveCallChord("hangUp", isMac);
  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={t("call.live.with", { name: bot.name })}
      className={cn(frame, "relative flex-wrap gap-x-2 gap-y-1 border-success/40")}
    >
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" aria-hidden />
      <span className="shrink-0 font-medium tabular-nums">{view.title}</span>
      {/* One line that always shows the newest words: right-to-left
          overflow clips the oldest words (and puts the ellipsis) on the left,
          while the text itself stays left-to-right. */}
      <span
        className={cn(
          "order-last w-full min-w-0 truncate text-left [direction:rtl] sm:order-none sm:w-auto sm:flex-1",
          view.heard ? "text-ink-tertiary" : "text-ink-secondary",
        )}
        title={spoken || undefined}
      >
        <bdi dir="ltr">{spoken}</bdi>
      </span>
      {view.hint && <span role="status" className="order-last w-full min-w-0 truncate text-[11.5px] text-warning" title={view.hint}>{view.hint}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <button
          ref={gearRef}
          type="button"
          aria-label={t("call.live.settings")}
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          className={cn(button, settingsOpen ? "text-ink" : "text-ink-secondary hover:text-ink")}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings className="size-3.5" />
        </button>
        <button
          type="button"
          aria-pressed={view.muted}
          aria-label={muteLabel}
          aria-keyshortcuts={muteChord.aria}
          title={`${muteLabel} (${muteChord.text})`}
          className={cn(button, view.muted ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}
          onClick={() => setLiveMuted(!view.muted)}
        >
          {view.muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
          <span className="hidden sm:inline">{muteLabel}</span>
        </button>
        <button
          type="button"
          disabled={view.ending}
          aria-label={t("call.live.hangUp")}
          aria-keyshortcuts={hangUpChord.aria}
          title={`${t("call.live.hangUp")} (${hangUpChord.text})`}
          className={cn(button, "bg-danger text-white hover:brightness-110 disabled:opacity-60")}
          onClick={() => void hangUpLiveCall()}
        >
          <PhoneOff className="size-3.5" /> <span className="hidden sm:inline">{t("call.live.hangUp")}</span>
        </button>
      </span>
      {settingsOpen && (
        <div className="absolute bottom-full right-0 z-40 mb-2">
          <LiveCallSettings
            onClose={() => {
              setSettingsOpen(false);
              gearRef.current?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}
