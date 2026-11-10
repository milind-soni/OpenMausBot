import { useState } from "react";

import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SettingRow, Switch } from "./SettingsPrimitives";

/** Saves one config change through PATCH /api/config, one at a time, and shows the server's answer or its error. */
function useConfigSave() {
  const { dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (patch: Record<string, unknown>) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, save };
}

export function BuiltInBrowserRow() {
  const { state } = useStore();
  const browser = builtInBrowserEnabled(state.config);
  const desktopBrowser = browserAvailable(state.config);
  const browserInstallable = state.config?.browserEngine?.installable === true;
  const browserBlockedOnWindows = window.ogb?.platform === "win32" && !desktopBrowser && !browserInstallable;
  const { saving, error, save } = useConfigSave();

  return (
    <SettingRow
    title={t("settings.experimental.browserAria")}
    subtitle={desktopBrowser
        ? browser
        ? t("settings.experimental.browserOn")
        : t("settings.experimental.browserOff")
        : browserBlockedOnWindows
        ? t("settings.experimental.browserWindows")
        : browserUnavailableReason(state.config)}
    message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Switch
          checked={browser}
          aria-label={t("settings.experimental.browserAria")}
          disabled={saving || (!browser && !desktopBrowser && !browserInstallable)}
          onClick={() => void save({ features: { browser: !browser } })}
          className="disabled:cursor-wait disabled:opacity-50"
      />
    </SettingRow>
  );
}

/** Self-hosted servers only, for the owner: browserEngine.egress.localNetwork lets bots' browsers open this server's
 * own sites and its local network. OpenMausBot's own ports, cloud metadata and link-local addresses stay closed. */
export function ServerSitesRow() {
  const { state } = useStore();
  const owner = useOwnerOrAdmin();
  const on = state.config?.browserEngine?.serverSites;
  const { saving, error, save } = useConfigSave();
  if (on === undefined || owner !== true || !builtInBrowserEnabled(state.config)) return null;

  return (
    <SettingRow
      title={t("settings.browser.serverSites")}
      subtitle={t("settings.browser.serverSitesDetail")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Switch
        checked={on}
        aria-label={t("settings.browser.serverSites")}
        disabled={saving}
        onClick={() => void save({ browserEngine: { egress: { localNetwork: !on } } })}
        className="disabled:cursor-wait disabled:opacity-50"
      />
    </SettingRow>
  );
}

/** Owner-only unauthenticated SOCKS5 upstream for public destinations. The endpoint is write-only in the UI. */
export function BrowserProxyRow() {
  const { state } = useStore();
  const owner = useOwnerOrAdmin();
  const configured = state.config?.browserEngine?.proxyConfigured === true;
  const saved = state.config?.browserEngine?.proxySaved === true || configured;
  const [endpoint, setEndpoint] = useState("");
  const { saving, error, save } = useConfigSave();
  if (owner !== true || !builtInBrowserEnabled(state.config)) return null;

  return (
    <SettingRow
      title={t("settings.browser.proxy")}
      subtitle={configured ? t("settings.browser.proxyConfigured") : saved ? t("settings.browser.proxyInactive") : t("settings.browser.proxyDetail")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <input
          aria-label={t("settings.browser.proxy")}
          autoComplete="off"
          spellCheck={false}
          placeholder="socks5://127.0.0.1:1080"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-control bg-app px-3 py-2 text-[13px] text-ink sm:w-64 sm:flex-none"
        />
        <button type="button" disabled={saving || !endpoint.trim()} onClick={() => void save({ browserEngine: { egress: { proxy: endpoint.trim() } } })} className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink disabled:opacity-50">
          {t("settings.browser.proxySave")}
        </button>
        {saved ? <button type="button" disabled={saving} onClick={() => void save({ browserEngine: { egress: { proxy: "" } } })} className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink disabled:opacity-50">{t("settings.browser.proxyClear")}</button> : null}
      </div>
    </SettingRow>
  );
}

/** browserEngine.engine: the bots' browsers run on OpenMausBot's own Chrome driver instead of agent-browser. */
export function NewBrowserSettings() {
  const { state } = useStore();
  const on = state.config?.browserEngine?.engine === "chrome";
  const { saving, error, save } = useConfigSave();

  return (
    <div className="mt-4 border-t border-hairline/30 pt-4" data-testid="new-browser-settings">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.experimental.newBrowser")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.experimental.newBrowserDetail")}</div>
        </div>
        <Switch
          checked={on}
          aria-label={t("settings.experimental.newBrowserAria")}
          disabled={saving}
          onClick={() => void save({ browserEngine: { engine: on ? "agent-browser" : "chrome" } })}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
