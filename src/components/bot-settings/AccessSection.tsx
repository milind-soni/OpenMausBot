// Access: where this bot runs, its working folder, connected apps and
// browser toggles, its webhooks, and the standing "always allowed" grants.
// Works on/cloud backend/auto-start VPS, Working folder, Connected apps, and
// Browser are moved verbatim from SettingsPanel.tsx; the connected-service
// list, webhooks list, and always-allowed list (the first read-only view of
// standing grants) are new.
import { useEffect, useState } from "react";
import { browserUnavailableReason } from "@/lib/feature-flags";
import { FolderOpen } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { shortPath } from "@/lib/short-path";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { CloudBackendPicker } from "../CloudBackendPicker";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { Switch } from "../SettingsPrimitives";
import { preloadConnectedApps, type ConnectorInventory } from "../PluginsPanel";
import { inputCls } from "./field";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this bot runs its shell and file tools.</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private bot workspace</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            placeholder="Private bot workspace — or an absolute path"
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          New tasks start here. This task is pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"} — start a new task to use the new folder.
        </div>
      )}
    </div>
  );
}

export function AccessSection({
  bot,
  derived,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
}) {
  const { state, dispatch } = useStore();
  const {
    patch,
    canUseVps,
    canUseConnectedApps,
    connectedAppsConfigured,
    connectedAppsEnabled,
    canUseBrowser,
    desktopBrowser,
    browserBlockedOnWindows,
    browserFeature,
    browserAllowed,
    browserEnabled,
    browserSelectable,
    browserDisabledReason,
    localSelectable,
    localDisabledReason,
  } = derived;
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const [inventory, setInventory] = useState<ConnectorInventory | null>(null);

  useEffect(() => {
    let cancelled = false;
    void preloadConnectedApps().then((result) => {
      if (!cancelled) setInventory(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const webhooks = state.webhooks.filter((webhook) => webhook.botId === bot.id);
  const alwaysAllow = bot.alwaysAllow ?? [];
  const connectedSlugs = inventory?.authoritative
    ? Object.entries(inventory.services)
        .filter(([, status]) => status.connected)
        .map(([slug]) => slug)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Works on</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          Where this bot works{bot.computer ? "" : " (currently: auto)"}. Browser is the built-in browser tab only; no desktop.
        </div>
        <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
          {([
            [null, "Auto"],
            ["cloud", "Cloud"],
            ["vm", "Local VM"],
            ["local", "This computer"],
            ["browser", "Browser"],
            ["off", "Off"],
          ] as const).map(([mode, label], i) => (
            <button
              key={mode ?? "auto"}
              disabled={(mode === "local" && !localSelectable) || (mode === "browser" && !browserSelectable)}
              title={
                mode === "local" && !localSelectable
                  ? localDisabledReason ?? undefined
                  : mode === "browser"
                    ? browserSelectable ? "The built-in browser tab only; no desktop" : browserDisabledReason
                    : undefined
              }
              onClick={() => {
                if ((mode === null && bot.computer === undefined) || mode === bot.computer) return;
                if (mode === "local" && derived.approvalMode === "auto") setLocalAutoWarning(bot.id);
                // a browser-only bot must actually have its browser: flip
                // the per-bot switch on with the destination
                else if (mode === "browser") patch({ computer: mode, browser: true });
                else patch({ computer: mode });
              }}
              className={cn(
                "flex-1 py-1.5 text-[13px] capitalize",
                i > 0 && "border-l border-hairline/40",
                ((mode === "local" && !localSelectable) || (mode === "browser" && !browserSelectable)) && "cursor-not-allowed opacity-40",
                (mode === null ? bot.computer === undefined : bot.computer === mode)
                  ? "bg-control text-ink"
                  : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {(!bot.computer || bot.computer === "cloud") && (
          <>
            {!bot.computer && (
              <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
                <span className="font-medium text-ink">Auto cloud preference.</span>{" "}
                This chooses what Auto may reuse during a task; viewing settings does not create or wake a computer.
              </div>
            )}
            <CloudBackendPicker
              value={bot.cloudBackend ?? "box"}
              vpsSupported={canUseVps}
              onChange={(backend) => patch({ cloudBackend: backend })}
            />
            {!bot.computer && bot.cloudBackend === "vps" && (
              <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">Start VPS automatically</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    Allow Auto to create or wake this bot's managed container when needed.
                  </div>
                </div>
                <Switch
                  checked={Boolean(bot.autoStartVps)}
                  aria-label="Start VPS automatically"
                  onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
                />
              </div>
            )}
          </>
        )}
      </div>

      <WorkingFolder bot={bot} />

      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-medium text-ink">Connected apps</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!connectedAppsConfigured
                ? "Connect apps in App Settings before giving this bot access."
                : !canUseConnectedApps
                  ? "This bot's current engine cannot use connected apps."
                  : connectedAppsEnabled
                    ? "Let this bot use your connected Gmail, Calendar, Slack, and other apps."
                    : "Keep your connected apps unavailable to this bot."}
            </div>
          </div>
          <Switch
            checked={connectedAppsEnabled}
            aria-label="Allow this bot to use connected apps"
            disabled={
              !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
            }
            onClick={() => patch({ composio: !connectedAppsEnabled })}
            title={
              !connectedAppsEnabled && !connectedAppsConfigured
                ? "Connect apps in App Settings first"
                : !connectedAppsEnabled && !canUseConnectedApps
                  ? "This engine cannot use connected apps"
                  : undefined
            }
            className="disabled:cursor-not-allowed"
          />
        </div>
        {connectedAppsEnabled && inventory?.authoritative && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {connectedSlugs.length === 0 ? (
              <span className="text-[11.5px] text-ink-secondary">No apps connected yet.</span>
            ) : (
              connectedSlugs.map((slug) => (
                <span key={slug} className="rounded-full bg-inset px-2 py-0.5 text-[11px] text-ink-secondary">
                  {slug}
                </span>
              ))
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">Browser</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {!desktopBrowser
              ? browserBlockedOnWindows
                ? "Not available on this Windows machine yet: install the browser engine with `openmausbot browser install`."
                : browserUnavailableReason(state.config)
              : !browserFeature
                ? "The built-in browser is switched off under App Settings → Experimental."
                : !canUseBrowser
                  ? "This bot's current engine cannot use the built-in browser."
                  : browserEnabled
                    ? "This bot has its own browser with its own logins."
                    : "Keep the built-in browser unavailable to this bot."}
          </div>
        </div>
        <Switch
          checked={browserEnabled}
          aria-label="Give this bot a built-in browser"
          disabled={!browserEnabled && (!desktopBrowser || !browserFeature || !canUseBrowser)}
          onClick={() => patch({ browser: !browserAllowed })}
          className="disabled:cursor-not-allowed"
        />
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Webhooks</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">Inbound triggers wired to this bot.</div>
        {webhooks.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">No webhooks for this bot.</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {webhooks.map((webhook) => (
              <div key={webhook.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{webhook.name}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    webhook.enabled ? "bg-accent/15 text-accent-text" : "bg-control text-ink-secondary",
                  )}
                >
                  {webhook.enabled ? "Active" : "Paused"}
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
                  {webhook.deliveryCount} deliveries
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Always allowed</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">Tools this bot no longer asks about.</div>
        {alwaysAllow.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">Nothing standing yet.</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {alwaysAllow.map((entry) => (
              <div key={entry} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{entry}</span>
                <button
                  type="button"
                  aria-label={`Remove ${entry} from always allowed`}
                  onClick={() => patch({ alwaysAllow: alwaysAllow.filter((key) => key !== entry) })}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target, patch: { computer: "local", acknowledgeLocalAuto: true } });
        }}
      />
    </div>
  );
}
