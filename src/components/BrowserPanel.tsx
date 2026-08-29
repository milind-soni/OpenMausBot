// The Browser tab of the computer panel. The page itself is a native
// WebContentsView the Electron main process owns; this component only draws
// the chrome around it (address, back, take-over, profile) and keeps main
// told where its rectangle is. Anything the renderer draws is painted UNDER
// the native view, so menus and dialogs that would overlap it hide it
// instead. Compact in the panel; expanded when handed the main column.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Globe, Hand, Loader2, Maximize2, Minimize2, Plus, UserRound } from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import { cn } from "@/lib/cn";
import { transitionBrowserControlLease } from "@/lib/computer-control";
import { useStore, type Bot, type BotAnnouncement, type BrowserProfile } from "@/state/store";

type ControlSnapshot = { held: boolean; helpReason: string | null };

const NATIVE_VIEW_OVERLAY_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="menu"], [popover], [data-native-view-overlay]';
const OWN_PROFILE = "";
const GUEST_PROFILE = "guest";
const NEW_PROFILE = "__new__";

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

/** A visible dialog/menu intersecting the host rectangle would be painted
 * under the native view — hide the view while it is up. */
function overlayIntersects(host: DesktopWorkspaceBounds): boolean {
  for (const node of document.querySelectorAll<HTMLElement>(NATIVE_VIEW_OVERLAY_SELECTOR)) {
    if (node.closest("[data-native-view-host]")) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const overlaps =
      rect.left < host.x + host.width && rect.right > host.x && rect.top < host.y + host.height && rect.bottom > host.y;
    if (overlaps) return true;
  }
  return false;
}

/** The editable address must retain the exact page URL. A shortened host/path
 * silently dropped schemes, queries and fragments on the next submission. */
export function editableUrl(url: string): string {
  if (!url || url === "about:blank") return "";
  return url;
}

function mutationAffectsOverlay(record: MutationRecord): boolean {
  if (record.type === "attributes") {
    return record.target instanceof Element && (
      record.target.matches(NATIVE_VIEW_OVERLAY_SELECTOR) ||
      Boolean(record.target.closest(NATIVE_VIEW_OVERLAY_SELECTOR)) ||
      Boolean(record.target.querySelector(NATIVE_VIEW_OVERLAY_SELECTOR))
    );
  }
  return [...record.addedNodes, ...record.removedNodes].some((node) =>
    node instanceof Element && (
      node.matches(NATIVE_VIEW_OVERLAY_SELECTOR) ||
      Boolean(node.querySelector(NATIVE_VIEW_OVERLAY_SELECTOR))
    ),
  );
}

/** "Work Microsoft" → "work-microsoft"; collisions get a numeric suffix. */
export function profileIdFor(name: string, taken: BrowserProfile[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "profile";
  let candidate = base;
  for (let n = 2; taken.some((profile) => profile.id === candidate); n += 1) candidate = `${base}-${n}`;
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

export function browserProfileChangesDisabled(bot: Pick<Bot, "busy">): boolean {
  return bot.busy === true;
}

export function BrowserPanel({
  bot,
  control,
  controlPending,
  onControl,
  size = "compact",
  onExpand,
  onCollapse,
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
  const hostRef = useRef<HTMLDivElement>(null);
  const nativeTakePending = useRef(false);
  const botBusyRef = useRef(browserProfileChangesDisabled(bot));
  // Async profile creation must only observe committed bot state. Updating the
  // ref during render lets an interrupted concurrent render leak a busy value
  // that React never committed and can strand the newly-created profile.
  useLayoutEffect(() => {
    botBusyRef.current = browserProfileChangesDisabled(bot);
  }, [bot.busy]);
  const [surface, setSurface] = useState<BrowserSurfaceState | null>(null);
  const [address, setAddress] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
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

  // Layout: tell main where the tab's rectangle is, on every change that can
  // move it (resize, scroll, sidebar toggles, dialogs). Coalesced per frame.
  // The profile rides along: switching it swaps the tab's session.
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    let frame = 0;
    const send = () => {
      if (!alive) return;
      const bounds = elementBounds(hostRef.current);
      const target = bounds && pageVisible && !overlayIntersects(bounds) ? bounds : null;
      bridge
        .layout(botId, target, activeProfile, size)
        .then((next) => {
          if (alive) setSurface(next);
        })
        .catch((cause) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause));
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
    // Portals may live anywhere under body, but normal app animation/style
    // churn must not produce a layout IPC call every frame.
    const mutation = new MutationObserver((records) => {
      if (records.some(mutationAffectsOverlay)) schedule();
    });
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "open", "aria-modal", "hidden"],
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      alive = false;
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      // The tab is gone; the page stays alive (a bot mid-task keeps its tab)
      // but nothing may paint over the chat.
      void bridge.layout(botId, null).catch(() => {});
    };
  }, [bridge, botId, pageVisible, activeProfile, size]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onState((next) => {
      if (next.botId === botId) setSurface(next);
    });
  }, [bridge, botId]);

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
            const applied = await bridge?.setHumanControl?.(botId, true, activeProfile) === true;
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
          const applied = await bridge.setHumanControl(botId, held, activeProfile);
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
    [activeProfile, botId, bridge, control.held, controlPending, onControl],
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
    if (!addressFocused) setAddress(editableUrl(surface?.url ?? ""));
  }, [surface?.url, addressFocused]);

  const navigate = useCallback(
    async (raw: string) => {
      if (!bridge) return;
      const target = raw.trim();
      if (!target) return;
      if (!(await changeControl("take"))) return;
      setBusy(true);
      setError(null);
      bridge
        .navigate(botId, target, activeProfile)
        .then(() => setAddressFocused(false))
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setBusy(false));
    },
    [activeProfile, bridge, botId, changeControl],
  );

  const back = async () => {
    if (!bridge) return;
    if (!(await changeControl("take"))) return;
    setError(null);
    await bridge.back(botId, activeProfile).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const chooseProfile = async (value: string) => {
    if (browserProfileChangesDisabled(bot) || profileBusy) {
      setError(`Stop ${bot.name}'s turn before changing its browser profile.`);
      return;
    }
    if (value === NEW_PROFILE) {
      setAddingProfile(true);
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
    if (!name || profileBusy || botBusyRef.current) return;
    setProfileBusy(true);
    setError(null);
    try {
      const id = profileIdFor(name, profiles);
      const config = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ browserProfiles: [...profiles, { id, name }] }),
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

  const currentUrl = surface?.url && surface.url !== "about:blank" ? surface.url : null;
  const expanded = size === "expanded";
  const profileChangesLocked = browserProfileChangesDisabled(bot);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
        <span className="flex items-center gap-2">
          {bot.name}'s browser
          {surface?.loading || busy ? <Loader2 size={13} className="animate-spin" /> : null}
        </span>
        {expanded && onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-control hover:text-ink"
            title="Back to the small view"
          >
            <Minimize2 size={13} /> Shrink
          </button>
        ) : onExpand ? (
          <button
            type="button"
            onClick={onExpand}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-control hover:text-ink"
            title="Show the page large"
          >
            <Maximize2 size={13} /> Expand
          </button>
        ) : null}
      </div>
      <form
        className="mb-2 flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate(address);
        }}
      >
        <button
          type="button"
          onClick={() => void back()}
          disabled={!surface?.canGoBack}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-inset px-2.5 py-1.5">
          <Globe size={13} className="shrink-0 text-ink-secondary" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            placeholder="Enter a web address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/70"
            aria-label="Web address"
          />
        </div>
        {currentUrl && (
          <button
            type="button"
            onClick={() => void window.ogb?.openExternal?.(currentUrl)}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink"
            title="Open in your default browser"
            aria-label="Open in your default browser"
          >
            <ExternalLink size={15} />
          </button>
        )}
      </form>

      {/* The native view is positioned over this box by the main process. In
          the panel it is a small preview — click it to expand. */}
      <div
        ref={hostRef}
        data-native-view-host
        onClick={!expanded && onExpand ? onExpand : undefined}
        role={!expanded && onExpand ? "button" : undefined}
        tabIndex={!expanded && onExpand ? 0 : undefined}
        onKeyDown={
          !expanded && onExpand
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onExpand();
              }
            : undefined
        }
        aria-label={!expanded && onExpand ? `Expand ${bot.name}'s browser` : undefined}
        title={!expanded && onExpand ? "Click to expand" : undefined}
        className={cn(
          "relative overflow-hidden rounded-xl border border-hairline/40 bg-inset",
          expanded ? "min-h-[320px] flex-1" : "aspect-[16/10] w-full shrink-0 cursor-zoom-in",
        )}
      >
        {!currentUrl && !surface?.loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-ink-secondary">
            <Globe size={22} className="opacity-60" />
            <span>Nothing open yet. Ask {bot.name} to look something up, or enter an address above.</span>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0 text-[12px] leading-relaxed text-ink-secondary">
          {control.held
            ? "You have the wheel — the bot waits until you hand it back."
            : "Click into the page to take over any time; the bot pauses while you drive."}
        </div>
        <button
          onClick={() => void changeControl(control.held ? "release" : "take")}
          disabled={controlPending}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-60",
            control.held ? "bg-accent text-accent-ink" : "bg-control text-ink hover:bg-raised-hover",
          )}
        >
          <Hand size={14} />
          {control.held ? "Hand back" : "Take control"}
        </button>
      </div>

      {/* Profile: which session (cookies, logins) this bot's tab uses. */}
      <div className="mt-3 rounded-xl bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink">
            <UserRound size={14} className="shrink-0 text-ink-secondary" />
            <span className="shrink-0">Profile</span>
            <select
              value={activeProfile}
              onChange={(event) => void chooseProfile(event.target.value)}
              disabled={profileBusy || profileChangesLocked}
              aria-label="Browser profile"
              className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none"
            >
              <option value={OWN_PROFILE}>{bot.name}'s own</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
              <option value={GUEST_PROFILE}>Guest (forgets everything)</option>
              <option value={NEW_PROFILE}>+ Add profile…</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => setAddingProfile((open) => !open)}
            disabled={profileChangesLocked}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            title={profileChangesLocked ? `Stop ${bot.name}'s turn before changing browser profiles` : "Add a profile"}
            aria-label="Add a profile"
          >
            <Plus size={15} />
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
              disabled={profileChangesLocked}
              className="min-w-0 flex-1 rounded-md bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/70"
              aria-label="New profile name"
            />
            <button
              type="submit"
              disabled={!newProfileName.trim() || profileBusy || profileChangesLocked}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setAddingProfile(false);
                setNewProfileName("");
              }}
              className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:text-ink"
            >
              Cancel
            </button>
          </form>
        )}
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
          {profileChangesLocked
            ? `Stop ${bot.name}'s current turn before changing profiles, so it cannot keep acting in a hidden session.`
            : `A profile is its own set of logins and cookies — sign in once and it stays. Bots pointed at the same profile share it; “${bot.name}'s own” is private to this bot; Guest is thrown away when you switch off it.`}
        </div>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
