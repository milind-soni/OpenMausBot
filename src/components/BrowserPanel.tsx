// The Browser tab of the computer panel. The page itself is a native
// WebContentsView the Electron main process owns; this component only draws
// the chrome around it (address, back, take-over, profile) and keeps main
// told where its rectangle is. Anything the renderer draws is painted UNDER
// the native view, so menus and dialogs that would overlap it hide it
// instead. Compact in the panel; expanded when handed the main column.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Hand,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  RotateCcw,
  UserRound,
} from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import { cn } from "@/lib/cn";
import { transitionBrowserControlLease } from "@/lib/computer-control";
import { useStore, type Bot, type BotAnnouncement, type BrowserProfile } from "@/state/store";
import { browserProfilePartitionId, browserProfilesForPatch } from "@/lib/browser-profiles";
import { useNativeViewObscured } from "@/hooks/use-native-view-obscured";

type ControlSnapshot = { held: boolean; helpReason: string | null };

const OWN_PROFILE = "";
const GUEST_PROFILE = "guest";

export type BrowserSurfacePresentation = "connecting" | "empty" | "loading" | "ready" | "failed";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function elementBounds(element: HTMLElement | null): DesktopWorkspaceBounds | null {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width < 1 || rect.height < 1) return null;
  return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
}

/** Center the fixed 1280×800 browser viewport inside an arbitrary workspace.
 * Electron receives only this rectangle, leaving an even renderer-owned
 * letterbox instead of anchoring the page to the top-left. */
export function aspectFitBrowserBounds(bounds: DesktopWorkspaceBounds): DesktopWorkspaceBounds {
  const widthFromHeight = Math.max(1, Math.floor(bounds.height * 1.6));
  if (widthFromHeight <= bounds.width) {
    return {
      x: bounds.x + Math.floor((bounds.width - widthFromHeight) / 2),
      y: bounds.y,
      width: widthFromHeight,
      height: bounds.height,
    };
  }
  const heightFromWidth = Math.max(1, Math.floor(bounds.width / 1.6));
  return {
    x: bounds.x,
    y: bounds.y + Math.floor((bounds.height - heightFromWidth) / 2),
    width: bounds.width,
    height: heightFromWidth,
  };
}

/** The editable address must retain the exact page URL. A shortened host/path
 * silently dropped schemes, queries and fragments on the next submission. */
export function editableUrl(url: string): string {
  if (!url || url === "about:blank") return "";
  return url;
}

function sameSurfaceState(left: BrowserSurfaceState | null, right: BrowserSurfaceState): boolean {
  return Boolean(
    left &&
      left.botId === right.botId &&
      left.open === right.open &&
      left.url === right.url &&
      left.title === right.title &&
      left.loading === right.loading &&
      left.canGoBack === right.canGoBack &&
      left.canGoForward === right.canGoForward &&
      left.visible === right.visible &&
      left.partition === right.partition &&
      left.profile === right.profile &&
      left.mode === right.mode &&
      left.code === right.code,
  );
}

/** Ignore a late event from the profile that was just switched away from. */
export function browserSurfaceForProfile(
  surface: BrowserSurfaceState | null,
  botId: string,
  profile: string,
): BrowserSurfaceState | null {
  return surface?.botId === botId && surface.profile === profile ? surface : null;
}

export function shouldAcceptBrowserSurfaceState(
  next: BrowserSurfaceState,
  botId: string,
  profile: string,
): boolean {
  if (next.botId !== botId) return false;
  // Terminal states intentionally omit profile/partition after the destroyed
  // entry is removed. Ordinary updates must match the active profile exactly:
  // an old hidden page may finish navigating after a profile switch.
  return Boolean(next.code) || next.profile === profile;
}

export function browserSurfacePresentation(input: {
  surface: BrowserSurfaceState | null;
  botId: string;
  profile: string;
  failureCode?: BrowserSurfaceState["code"];
  actionPending?: boolean;
  retrying?: boolean;
}): BrowserSurfacePresentation {
  if (input.retrying || input.actionPending) return "loading";
  if (input.failureCode) return "failed";
  const active = browserSurfaceForProfile(input.surface, input.botId, input.profile);
  if (!active) return "connecting";
  if (active.loading) return "loading";
  if (!active.url || active.url === "about:blank") return "empty";
  return "ready";
}

export function shouldClearBrowserSurfaceFailure(
  presentation: BrowserSurfacePresentation,
  next: BrowserSurfaceState,
): boolean {
  return !next.code && presentation !== "failed";
}

function browserSurfaceFailureText(code: BrowserSurfaceState["code"]): string {
  if (code === "renderer-gone") return "The page stopped unexpectedly.";
  if (code === "evicted") return "This page was paused to free memory.";
  return "The browser surface needs to be reopened.";
}

export function BrowserSurfacePlaceholder({
  presentation,
  botName,
  failureCode,
  onRetry,
}: {
  presentation: BrowserSurfacePresentation;
  botName: string;
  failureCode?: BrowserSurfaceState["code"];
  onRetry?: () => void;
}) {
  if (presentation === "ready") return null;
  if (presentation === "failed") {
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center text-[13px] text-ink-secondary"
        role="alert"
      >
        <AlertTriangle size={22} className="text-danger" aria-hidden="true" />
        <div>
          <div className="font-medium text-ink">Page unavailable</div>
          <div className="mt-0.5">{browserSurfaceFailureText(failureCode)}</div>
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 font-medium text-ink outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-accent"
          >
            <RotateCcw size={13} aria-hidden="true" /> Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (presentation === "empty") {
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-ink-secondary"
        role="status"
      >
        <Globe size={22} className="opacity-60" aria-hidden="true" />
        <span>Nothing open yet. Ask {botName} to look something up, or enter an address above.</span>
      </div>
    );
  }
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px] text-ink-secondary"
      role="status"
      aria-live="polite"
    >
      <Loader2 size={20} className="animate-spin text-accent" aria-hidden="true" />
      <span>{presentation === "connecting" ? "Preparing browser…" : "Opening page…"}</span>
    </div>
  );
}

/** "Work Microsoft" → "work-microsoft"; collisions get a numeric suffix. */
export function profileIdFor(name: string, taken: BrowserProfile[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "profile";
  let candidate = base;
  for (let n = 2; candidate === GUEST_PROFILE || taken.some((profile) => profile.id === candidate); n += 1) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

export function shouldRequestBrowserControl(input: {
  botId: string;
  eventBotId: string;
  held: boolean;
  pending: boolean;
  takeInFlight: boolean;
}): boolean {
  return input.botId === input.eventBotId && !input.held && !input.pending && !input.takeInFlight;
}

export function browserProfileChangesDisabled(
  bot: Pick<Bot, "busy">,
  pending: { browserAction?: boolean; controlTransition?: boolean } = {},
): boolean {
  return bot.busy === true || pending.browserAction === true || pending.controlTransition === true;
}

export function BrowserPanel({
  bot,
  control,
  controlPending,
  onControl,
  size = "compact",
  onExpand,
}: {
  bot: Bot;
  control: ControlSnapshot;
  controlPending: boolean;
  onControl: (action: "take" | "release") => Promise<boolean>;
  size?: "compact" | "expanded";
  /** Compact only: hand the tab to the main column. */
  onExpand?: () => void;
  /** Expanded only: hand the tab back to the panel. */
  onCollapse?: () => void;
}) {
  const { state, dispatch } = useStore();
  const bridge = window.ogb?.browser;
  const pageVisible = usePageVisible();
  const layoutOwner = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const nativeViewObscured = useNativeViewObscured(hostRef);
  const nativeTakePending = useRef(false);
  const botBusyRef = useRef(browserProfileChangesDisabled(bot));
  // Async profile creation must only observe committed bot state. Updating the
  // ref during render lets an interrupted concurrent render leak a busy value
  // that React never committed and can strand the newly-created profile.
  useLayoutEffect(() => {
    botBusyRef.current = browserProfileChangesDisabled(bot);
  }, [bot.busy]);
  const [surface, setSurface] = useState<BrowserSurfaceState | null>(null);
  const [surfaceFailure, setSurfaceFailure] = useState<{
    profile: string;
    code: NonNullable<BrowserSurfaceState["code"]>;
  } | null>(null);
  const [address, setAddress] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const acceptSurface = useCallback((next: BrowserSurfaceState) => {
    setSurface((current) => (sameSurfaceState(current, next) ? current : next));
  }, []);
  const botId = bot.id;
  const profiles = state.config?.browserProfiles ?? [];
  // a profile that was deleted falls back to the bot's own session; Guest is
  // never in the list, it is a throwaway the surface forgets on switch-away
  const activeProfile =
    bot.browserProfile === GUEST_PROFILE
      ? GUEST_PROFILE
      : bot.browserProfile && profiles.some((profile) => profile.id === bot.browserProfile)
        ? bot.browserProfile
        : OWN_PROFILE;
  const activePartition = activeProfile === OWN_PROFILE || activeProfile === GUEST_PROFILE
    ? activeProfile
    : browserProfilePartitionId(profiles, activeProfile);
  const activeSurface = browserSurfaceForProfile(surface, botId, activePartition);
  const currentUrl = activeSurface?.url && activeSurface.url !== "about:blank" ? activeSurface.url : null;
  const activeFailureCode = surfaceFailure?.profile === activePartition ? surfaceFailure.code : undefined;
  const presentation = browserSurfacePresentation({
    surface,
    botId,
    profile: activePartition,
    failureCode: activeFailureCode,
    actionPending: busy,
    retrying,
  });
  // A connecting surface must be laid out once so Electron can create (or
  // restore) the selected profile. Empty/loading/failed states remain hidden
  // so the renderer's useful status is not covered by about:blank.
  const shouldPlaceNativeSurface = presentation === "connecting" || presentation === "ready" || retrying;
  // A profile switch changes the native session underneath this panel. Keep
  // that transition serialized with address-bar navigation, history changes,
  // and takeover handoff so an old page cannot finish in a hidden profile (or
  // be destroyed mid-load when the old profile is Guest).
  const profileChangesLocked = browserProfileChangesDisabled(bot, {
    browserAction: busy,
    controlTransition: controlPending,
  });
  const profileChangeLockMessage = bot.busy
    ? `Stop ${bot.name}'s current turn before changing profiles.`
    : profileChangesLocked
      ? "Finish the current browser action before changing profiles."
      : null;

  // Layout: tell main where the tab's rectangle is, on every change that can
  // move it (resize, scroll, sidebar toggles, dialogs). Coalesced per frame.
  // The profile rides along: switching it swaps the tab's session.
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    let frame = 0;
    const send = () => {
      if (!alive) return;
      const rawBounds = elementBounds(hostRef.current);
      const bounds = rawBounds && size === "expanded" ? aspectFitBrowserBounds(rawBounds) : rawBounds;
      const target = bounds && pageVisible && !nativeViewObscured && shouldPlaceNativeSurface ? bounds : null;
      bridge
        .layout(botId, target, activePartition, size, layoutOwner)
        .then((next) => {
          if (!alive) return;
          acceptSurface(next);
          // A terminal entry has already been removed, so a hide-only layout
          // returns an ordinary closed state. Keep the failure visible until
          // the person explicitly retries and creates a replacement entry.
          if (shouldClearBrowserSurfaceFailure(presentation, next)) setSurfaceFailure(null);
          if (retrying) setRetrying(false);
        })
        .catch((cause) => {
          if (!alive) return;
          setRetrying(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        send();
      });
    };
    send();
    const resize = new ResizeObserver(schedule);
    if (hostRef.current) resize.observe(hostRef.current);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      alive = false;
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      // The tab is gone; the page stays alive (a bot mid-task keeps its tab)
      // but nothing may paint over the chat. Scope the hide to this profile:
      // cleanup from an old selection must not hide the newly selected one.
      void bridge.layout(botId, null, activePartition, size, layoutOwner).catch(() => {});
    };
  }, [
    bridge,
    botId,
    pageVisible,
    activePartition,
    layoutOwner,
    size,
    acceptSurface,
    nativeViewObscured,
    presentation,
    retrying,
    shouldPlaceNativeSurface,
  ]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onState((next) => {
      if (!shouldAcceptBrowserSurfaceState(next, botId, activePartition)) return;
      acceptSurface(next);
      if (next.code) {
        setSurfaceFailure({ profile: activePartition, code: next.code });
      } else if (next.profile === activePartition) {
        setSurfaceFailure(null);
      }
    });
  }, [bridge, botId, activePartition, acceptSurface]);

  useEffect(() => {
    // Keep the synchronous guard set until React has folded the successful
    // server snapshot. Native focus and the first mouse event commonly arrive
    // back-to-back; neither should start a second control request.
    if (control.held) nativeTakePending.current = false;
  }, [control.held]);

  const changeControl = useCallback(
    async (action: "take" | "release"): Promise<boolean> => {
      if (action === "take") {
        if (control.held) {
          try {
            const applied = await bridge?.setHumanControl?.(botId, true, activePartition) === true;
            if (!applied) setError("The browser tab is not ready for takeover yet.");
            return applied;
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return false;
          }
        }
        if (controlPending || nativeTakePending.current) return false;
        nativeTakePending.current = true;
      }
      const setLocalControl = async (held: boolean): Promise<boolean> => {
        try {
          if (!bridge?.setHumanControl) throw new Error("Update OpenMausBot before using browser takeover.");
          const applied = await bridge.setHumanControl(botId, held, activePartition);
          if (!applied) throw new Error("The browser tab is not ready for takeover yet.");
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return false;
        }
      };

      const result = await transitionBrowserControlLease({
        action,
        requestDurableControl: (requested) => onControl(requested).catch(() => false),
        setNativeControl: setLocalControl,
      });
      if (result.ok) return true;
      if (result.failed === "durable-take") {
        // The person may already be typing into the native page. Keep the
        // agent gated even though the durable lease endpoint failed; a
        // subsequent Take control click retries the server transition.
        setError("Browser control could not be confirmed. The bot remains paused here for safety — retry Take control.");
      } else if (result.failed === "durable-release") {
        setError("Control could not be handed back. The bot remains paused here for safety — retry Hand back.");
      } else if (result.failed === "native-release") {
        setError("The server released control, but this browser remains paused locally for safety. Reopen the Browser panel to retry.");
      }
      if (action === "take") nativeTakePending.current = false;
      return false;
    },
    [activePartition, botId, bridge, control.held, controlPending, onControl],
  );

  useEffect(() => {
    if (!bridge?.onUserInteraction) return;
    return bridge.onUserInteraction((event) => {
      if (!shouldRequestBrowserControl({
        botId,
        eventBotId: event.botId,
        held: control.held,
        pending: controlPending,
        takeInFlight: nativeTakePending.current,
      })) return;
      if (size === "compact") onExpand?.();
      void changeControl("take");
    });
  }, [bridge, botId, changeControl, control.held, controlPending, onExpand, size]);

  useEffect(() => {
    if (!addressFocused) setAddress(editableUrl(activeSurface?.url ?? ""));
  }, [activeSurface?.url, activePartition, addressFocused]);

  const navigate = useCallback(
    async (raw: string) => {
      if (!bridge || busy || profileBusy) return;
      const target = raw.trim();
      if (!target) return;
      setBusy(true);
      setError(null);
      try {
        if (!(await changeControl("take"))) return;
        await bridge.navigate(botId, target, activePartition);
        setAddressFocused(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [activePartition, bridge, botId, busy, changeControl, profileBusy],
  );

  const moveHistory = useCallback(async (direction: "back" | "forward") => {
    if (!bridge || busy || profileBusy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await changeControl("take"))) return;
      if (direction === "back") await bridge.back(botId, activePartition);
      else if (bridge.forward) await bridge.forward(botId, activePartition);
      else throw new Error("Update OpenMausBot before using Forward.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [activePartition, botId, bridge, busy, changeControl, profileBusy]);

  const reload = useCallback(async () => {
    if (!bridge?.reload || busy || profileBusy || !currentUrl) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await changeControl("take"))) return;
      await bridge.reload(botId, activePartition);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [activePartition, botId, bridge, busy, changeControl, currentUrl, profileBusy]);

  const chooseProfile = async (value: string) => {
    if (profileBusy || profileChangesLocked) {
      setError(profileChangeLockMessage ?? "Wait for the current profile change to finish.");
      return;
    }
    setProfileBusy(true);
    setError(null);
    try {
      // Let the server serialize this against turn start. An optimistic bot
      // patch can briefly show a new profile while the active capability is
      // still pinned to the old hidden view.
      const result: { bot: BotAnnouncement } = await api(`/api/bots/${botId}`, {
        method: "PATCH",
        body: JSON.stringify({ browserProfile: value === OWN_PROFILE ? null : value }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProfileBusy(false);
    }
  };

  const addProfile = async () => {
    const name = newProfileName.trim();
    if (!name || profileBusy || profileChangesLocked || botBusyRef.current) return;
    setProfileBusy(true);
    setError(null);
    try {
      const id = profileIdFor(name, profiles);
      const config = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ browserProfiles: browserProfilesForPatch([...profiles, { id, name }]) }),
      });
      dispatch({ type: "configStatus", config });
      if (botBusyRef.current) {
        setAddingProfile(false);
        setNewProfileName("");
        setError(`Created ${name}, but ${bot.name}'s turn started before it could switch profiles. Stop the turn, then select it.`);
        return;
      }
      const result: { bot: BotAnnouncement } = await api(`/api/bots/${botId}`, {
        method: "PATCH",
        body: JSON.stringify({ browserProfile: id }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
      setAddingProfile(false);
      setNewProfileName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProfileBusy(false);
    }
  };

  if (!bridge) {
    return (
      <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">
        The built-in browser needs the OpenMausBot desktop app.
      </div>
    );
  }

  const expanded = size === "expanded";

  return (
    <div className={cn("flex h-full min-h-0 flex-col", !expanded && "overflow-y-auto overscroll-contain pr-0.5")}>
      {!expanded ? (
        <div className="mb-2 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
          <span className="flex items-center gap-2" aria-live="polite">
            {bot.name}'s browser
            {presentation === "loading" || presentation === "connecting" ? (
              <Loader2 size={13} className="animate-spin" aria-label="Browser is loading" />
            ) : null}
          </span>
          {onExpand ? (
            <button
              type="button"
              onClick={onExpand}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
              title="Show the page large"
            >
              <Maximize2 size={13} aria-hidden="true" /> Expand
            </button>
          ) : null}
        </div>
      ) : null}
      <form
        className={cn("mb-2 flex items-center gap-1.5", expanded && "mt-3")}
        onSubmit={(event) => {
          event.preventDefault();
          void navigate(address);
        }}
      >
        <button
          type="button"
          onClick={() => void moveHistory("back")}
          disabled={!activeSurface?.canGoBack || busy || profileBusy}
          className="rounded-md p-1.5 text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void moveHistory("forward")}
          disabled={!bridge.forward || !activeSurface?.canGoForward || busy || profileBusy}
          className="rounded-md p-1.5 text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={!bridge.reload || !currentUrl || busy || profileBusy}
          className="rounded-md p-1.5 text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          title="Reload"
          aria-label="Reload"
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-inset px-2.5 py-1.5 focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20">
          <Globe size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            placeholder="Enter a web address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy || profileBusy}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/70"
            aria-label="Web address"
          />
        </div>
        <button
          type="submit"
          disabled={!address.trim() || busy || profileBusy}
          className="rounded-lg bg-control px-2.5 py-1.5 text-[12px] font-medium text-ink outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Go
        </button>
        {currentUrl && (
          <button
            type="button"
            onClick={() => void window.ogb?.openExternal?.(currentUrl)}
            className="rounded-md p-1.5 text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            title="Open in your default browser"
            aria-label="Open in your default browser"
          >
            <ExternalLink size={15} aria-hidden="true" />
          </button>
        )}
      </form>

      {/* Keep a visible renderer frame around the rectangular native view.
          Compact clicks are consumed by Electron: the first click expands and
          takes control without also activating whatever is underneath it. */}
      <div
        onClick={!expanded && onExpand ? onExpand : undefined}
        title={!expanded && onExpand ? "Click to expand" : undefined}
        data-browser-presentation={presentation}
        className={cn(
          "relative overflow-hidden rounded-2xl border border-hairline/60 bg-card p-[3px] shadow-sm shadow-black/10",
          expanded
            ? "min-h-[320px] flex-1"
            : "aspect-[16/10] w-full max-w-[720px] shrink-0 self-center cursor-zoom-in",
        )}
      >
        <div
          ref={hostRef}
          data-native-view-host
          aria-busy={presentation === "connecting" || presentation === "loading"}
          className="absolute inset-[3px] overflow-hidden rounded-[13px] bg-inset"
        >
          <BrowserSurfacePlaceholder
            presentation={presentation}
            botName={bot.name}
            failureCode={activeFailureCode}
            onRetry={() => {
              setError(null);
              setRetrying(true);
            }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0 text-[12px] leading-relaxed text-ink-secondary">
          {control.held
            ? "You have the wheel — the bot waits until you hand it back."
            : "Click into the page to take over any time; the bot pauses while you drive."}
        </div>
        <button
          type="button"
          onClick={() => void changeControl(control.held ? "release" : "take")}
          disabled={controlPending || busy || profileBusy}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60",
            control.held ? "bg-accent text-accent-ink" : "bg-control text-ink hover:bg-raised-hover",
          )}
        >
          <Hand size={14} aria-hidden="true" />
          {control.held ? "Hand back" : "Take control"}
        </button>
      </div>

      {/* Profile: which session (cookies, logins) this bot's tab uses. */}
      <div className="mt-3 rounded-xl border border-hairline/30 bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink">
            <UserRound size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
            <span className="shrink-0">Profile</span>
            <select
              value={activeProfile}
              onChange={(event) => void chooseProfile(event.target.value)}
              disabled={profileBusy || profileChangesLocked}
              aria-label="Browser profile"
              className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <option value={OWN_PROFILE}>{bot.name}'s own</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
              <option value={GUEST_PROFILE}>Guest (forgets everything)</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => setAddingProfile((open) => !open)}
            disabled={profileBusy || profileChangesLocked}
            className="rounded-md p-1.5 text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            title={profileChangeLockMessage ?? "Add a profile"}
            aria-label="Add a profile"
            aria-expanded={addingProfile}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
        {addingProfile && (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addProfile();
            }}
          >
            <input
              autoFocus
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
              placeholder="Profile name, e.g. Work"
              maxLength={40}
              disabled={profileBusy || profileChangesLocked}
              className="min-w-0 flex-1 rounded-md bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/70 focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="New profile name"
            />
            <button
              type="submit"
              disabled={!newProfileName.trim() || profileBusy || profileChangesLocked}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setAddingProfile(false);
                setNewProfileName("");
              }}
              className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              Cancel
            </button>
          </form>
        )}
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
          {profileChangesLocked
            ? bot.busy
              ? `Stop ${bot.name}'s current turn before changing profiles, so it cannot keep acting in a hidden session.`
              : profileChangeLockMessage
            : `Profiles keep logins separate. “${bot.name}'s own” is private to this bot; Guest is cleared when you switch away.`}
        </div>
      </div>
      {error && (
        <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
    </div>
  );
}
