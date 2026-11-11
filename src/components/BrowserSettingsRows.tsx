import { useState } from "react";

import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { useSettingsPlace } from "./settings/settings-place";
import { productName } from "@/lib/brand";

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
        ? t("settings.browser.onShort")
        : t("settings.browser.offShort")
        : browserBlockedOnWindows
        ? t("settings.experimental.browserWindows")
        : browserInstallable ? t("settings.browser.notInstalledShort")
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
  const place = useSettingsPlace();
  const { saving, error, save } = useConfigSave();
  if (on === undefined || owner !== true || !builtInBrowserEnabled(state.config)) return null;

  return (
    <SettingRow
      title={t("settings.browser.localSites")}
      subtitle={t("settings.browser.localSitesLine", { place: place.name, app: productName() })}
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

/** browserEngine.engine: the bots' browsers run on OpenMausBot's own Chrome driver instead of agent-browser. */
export function NewBrowserSettings() {
  const { state } = useStore();
  const on = state.config?.browserEngine?.engine === "chrome";
  const { saving, error, save } = useConfigSave();

  return (
    <div data-testid="new-browser-settings" className="contents">
      <SettingRow title={t("settings.experimental.newBrowser")} subtitle={t("settings.experimental.newBrowserDetail")}
        message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Switch
          checked={on}
          aria-label={t("settings.experimental.newBrowserAria")}
          disabled={saving}
          onClick={() => void save({ browserEngine: { engine: on ? "agent-browser" : "chrome" } })}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </SettingRow>
    </div>
  );
}
