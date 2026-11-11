import { useState } from "react";

import { t } from "@/lib/i18n";
import { setWebPanels, useWebPanels } from "@/lib/web-panel-preferences";
import { MAX_WEB_PANELS, MAX_WEB_PANEL_NAME, newWebPanelId, validateWebPanel } from "@/lib/web-panels";

import { cn } from "@/lib/cn";
import { SETTINGS_INPUT, SettingRow, SettingsEmptyRow, SettingsField, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";

/** Settings → General: pages pinned to the sidebar (Advanced mode). */
export function PinnedPanelsSettings() {
  const panels = useWebPanels();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<"name" | "url" | "self" | "">("");
  const full = panels.length >= MAX_WEB_PANELS;

  const [adding, setAdding] = useState(false);
  const add = (): boolean => {
    const check = validateWebPanel({ name, url }, window.location.origin);
    if (!check.ok) {
      setError(check.error);
      return false;
    }
    setWebPanels([...panels, { id: newWebPanelId(panels), name: check.name, url: check.url }]);
    setName("");
    setUrl("");
    setError("");
    return true;
  };

  const close = () => { setAdding(false); setName(""); setUrl(""); setError(""); };
  return (
    <SettingsGroup label={t("webPanels.settings.title")} block="pinned-panels" description={t("webPanels.settings.short")}
      actions={<button type="button" className="ui-button" disabled={full} onClick={() => setAdding(true)}>{t("webPanels.settings.addPage")}</button>}
      footnote={full ? t("webPanels.settings.full", { max: MAX_WEB_PANELS }) : t("webPanels.settings.help")}>
      <SettingsRows>
        {panels.length === 0 && <SettingsEmptyRow>{t("webPanels.settings.empty")}</SettingsEmptyRow>}
        {panels.map((panel) => (
          <SettingRow key={panel.id} title={panel.name} subtitle={<span className="block truncate" title={panel.url}>{panel.url ?? t("webPanels.settings.chatPage")}</span>}>
            <button type="button" data-danger="" className="settings-quiet cursor-pointer" onClick={() => setWebPanels(panels.filter((entry) => entry.id !== panel.id))}>
              {t("webPanels.settings.remove")}
            </button>
          </SettingRow>
        ))}
      </SettingsRows>
      {adding && (
        <SettingsDialog title={t("webPanels.settings.addPage")} onClose={close}
          footer={<>
            <button type="button" className="ui-button" onClick={close}>{t("common.cancel")}</button>
            <button type="button" className="ui-button ui-button-primary" disabled={full} onClick={() => { if (add()) close(); }}>{t("webPanels.settings.add")}</button>
          </>}>
          <SettingsField label={t("webPanels.settings.name")}>
            <input value={name} maxLength={MAX_WEB_PANEL_NAME} aria-invalid={error === "name"} onChange={(event) => { setName(event.target.value); setError(""); }}
              className={cn(SETTINGS_INPUT, error === "name" && "border-danger/60")} />
          </SettingsField>
          <SettingsField label={t("webPanels.settings.url")}>
            <input placeholder="https://" type="url" inputMode="url" value={url} aria-invalid={error === "url" || error === "self"}
              onChange={(event) => { setUrl(event.target.value); setError(""); }} onKeyDown={(event) => { if (event.key === "Enter" && add()) close(); }}
              className={cn(SETTINGS_INPUT, (error === "url" || error === "self") && "border-danger/60")} />
          </SettingsField>
          {error && (
            <p role="alert" className="text-[12px] leading-4 text-danger">
              {t(error === "name" ? "webPanels.settings.nameInvalid" : error === "self" ? "webPanels.settings.urlSelf" : "webPanels.settings.urlInvalid", { max: MAX_WEB_PANEL_NAME })}
            </p>
          )}
        </SettingsDialog>
      )}
    </SettingsGroup>
  );
}
