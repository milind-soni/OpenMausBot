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
import { t } from "@/lib/i18n";
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
      <div className="text-[15px] font-medium text-ink">{t("botSettings.access.folder")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botSettings.access.folderHint")}</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("botSettings.access.privateWorkspace")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> {t("botSettings.access.choose")}
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("botSettings.access.clear")}
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
            placeholder={t("botSettings.access.folderPlaceholder")}
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("botSettings.access.save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          {/* Same split-on-the-placeholder shape the Android setup steps use,
              so the pinned path keeps its monospace run inside a translated
              sentence. */}
          {t("botSettings.access.pinnedElsewhere").split("{folder}").flatMap((part, index) =>
            index === 0
              ? [part]
              : [
                  pinned
                    ? <span key="folder" className="font-mono">{shortPath(pinned, home)}</span>
                    : t("botSettings.access.pinnedHome"),
                  part,
                ],
          )}
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
  const browserInstallable = state.config?.browserEngine?.installable === true;
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
        <div className="text-[15px] font-medium text-ink">{t("botSettings.access.worksOn")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {t("botSettings.access.worksOnHint", {
            auto: bot.computer ? "" : t("botSettings.access.currentlyAuto"),
          })}
        </div>
        <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
          {([
            [null, "vm.dest.auto"],
            ["cloud", "vm.dest.cloud"],
            ["vm", "vm.dest.vm"],
            ["local", "vm.dest.local"],
            ["browser", "vm.dest.browser"],
            ["off", "vm.dest.off"],
          ] as const).map(([mode, labelKey], i) => (
            <button
              key={mode ?? "auto"}
              disabled={(mode === "local" && !localSelectable) || (mode === "browser" && !browserSelectable)}
              title={
                mode === "local" && !localSelectable
                  ? localDisabledReason ?? undefined
                  : mode === "browser"
                    ? browserSelectable ? t("computer.browserOnlyTitle") : browserDisabledReason
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
              {t(labelKey)}
            </button>
          ))}
        </div>
        {(!bot.computer || bot.computer === "cloud") && (
          <>
            {!bot.computer && (
              <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
                <span className="font-medium text-ink">{t("botSettings.access.autoCloudTitle")}</span>{" "}
                {t("botSettings.access.autoCloudHint")}
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
                  <div className="text-[13px] text-ink">{t("botSettings.access.autoStartVps")}</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {t("botSettings.access.autoStartVpsHint")}
                  </div>
                </div>
                <Switch
                  checked={Boolean(bot.autoStartVps)}
                  aria-label={t("botSettings.access.autoStartVps")}
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
            <div className="text-[15px] font-medium text-ink">{t("botSettings.access.connectedApps")}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!connectedAppsConfigured
                ? t("botSettings.access.appsNotConfigured")
                : !canUseConnectedApps
                  ? t("botSettings.access.appsEngine")
                  : connectedAppsEnabled
                    ? t("botSettings.access.appsOn")
                    : t("botSettings.access.appsOff")}
            </div>
          </div>
          <Switch
            checked={connectedAppsEnabled}
            aria-label={t("botSettings.access.appsAria")}
            disabled={
              !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
            }
            onClick={() => patch({ composio: !connectedAppsEnabled })}
            title={
              !connectedAppsEnabled && !connectedAppsConfigured
                ? t("botSettings.access.appsConnectFirst")
                : !connectedAppsEnabled && !canUseConnectedApps
                  ? t("botSettings.access.appsEngineShort")
                  : undefined
            }
            className="disabled:cursor-not-allowed"
          />
        </div>
        {connectedAppsEnabled && inventory?.authoritative && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {connectedSlugs.length === 0 ? (
              <span className="text-[11.5px] text-ink-secondary">{t("botSettings.access.noAppsYet")}</span>
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
          <div className="text-[15px] font-medium text-ink">{t("botSettings.access.browser")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {!desktopBrowser
              ? browserBlockedOnWindows && !browserInstallable
                ? t("botSettings.access.browserWindows")
                : browserUnavailableReason(state.config)
              : !browserFeature
                ? t("botSettings.access.browserOff")
                : !canUseBrowser
                  ? t("botSettings.access.browserEngine")
                  : browserEnabled
                    ? t("botSettings.access.browserOn")
                    : t("botSettings.access.browserKeepOff")}
          </div>
        </div>
        <Switch
          checked={browserEnabled}
          aria-label={t("botSettings.access.browserAria")}
          disabled={!browserEnabled && ((!desktopBrowser && !browserInstallable) || !browserFeature || !canUseBrowser)}
          onClick={() => patch({ browser: !browserAllowed })}
          className="disabled:cursor-not-allowed"
        />
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botSettings.access.webhooks")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botSettings.access.webhooksHint")}</div>
        {webhooks.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("botSettings.access.webhooksEmpty")}</div>
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
                  {webhook.enabled ? t("botSettings.routines.active") : t("botSettings.routines.paused")}
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
                  {t("botSettings.access.deliveries", { count: webhook.deliveryCount })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botSettings.access.alwaysAllowed")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botSettings.access.alwaysAllowedHint")}</div>
        {alwaysAllow.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("botSettings.access.nothingStanding")}</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {alwaysAllow.map((entry) => (
              <div key={entry} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{entry}</span>
                <button
                  type="button"
                  aria-label={t("botSettings.access.removeGrantAria", { name: entry })}
                  onClick={() => patch({ alwaysAllow: alwaysAllow.filter((key) => key !== entry) })}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
                >
                  {t("botSettings.access.remove")}
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
