import { useState } from "react";

import { t } from "@/lib/i18n";
import { setWebPanels, useWebPanels } from "@/lib/web-panel-preferences";
import { MAX_WEB_PANELS, MAX_WEB_PANEL_NAME, newWebPanelId, validateWebPanel } from "@/lib/web-panels";

import { Card } from "./SettingsPrimitives";

const field = "min-w-0 rounded-lg border bg-inset px-3 py-2 text-[14px] text-ink focus:outline-none";

/** Settings → General: pages pinned to the sidebar (Advanced mode). */
export function PinnedPanelsSettings() {
  const panels = useWebPanels();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<"name" | "url" | "self" | "">("");
  const full = panels.length >= MAX_WEB_PANELS;

  const add = () => {
    const check = validateWebPanel({ name, url }, window.location.origin);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setWebPanels([...panels, { id: newWebPanelId(panels), name: check.name, url: check.url }]);
    setName("");
    setUrl("");
    setError("");
  };

  return (
    <Card title={t("webPanels.settings.title")} subtitle={t("webPanels.settings.subtitle")}>
      <div className="flex flex-col gap-3">
        {panels.length > 0 && (
          <ul className="flex flex-col divide-y divide-hairline/40 rounded-lg border border-hairline/40">
            {panels.map((panel) => (
              <li key={panel.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-ink">{panel.name}</p>
                  <p className="truncate text-[12px] text-ink-secondary" title={panel.url}>{panel.url}</p>
                </div>
                <button
                  type="button"
                  className="ui-button text-danger"
                  onClick={() => setWebPanels(panels.filter((entry) => entry.id !== panel.id))}
                >
                  {t("webPanels.settings.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            aria-label={t("webPanels.settings.name")}
            placeholder={t("webPanels.settings.name")}
            value={name}
            maxLength={MAX_WEB_PANEL_NAME}
            disabled={full}
            aria-invalid={error === "name"}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            className={`${field} sm:w-40 ${error === "name" ? "border-danger/60" : "border-hairline/40 focus:border-focus"}`}
          />
          <input
            aria-label={t("webPanels.settings.url")}
            placeholder="https://"
            type="url"
            inputMode="url"
            value={url}
            disabled={full}
            aria-invalid={error === "url" || error === "self"}
            onChange={(event) => { setUrl(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") add(); }}
            className={`${field} flex-1 ${error === "url" || error === "self" ? "border-danger/60" : "border-hairline/40 focus:border-focus"}`}
          />
          <button type="button" className="ui-button" disabled={full} onClick={add}>
            {t("webPanels.settings.add")}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {t(error === "name" ? "webPanels.settings.nameInvalid" : error === "self" ? "webPanels.settings.urlSelf" : "webPanels.settings.urlInvalid", { max: MAX_WEB_PANEL_NAME })}
          </p>
        )}
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          {full ? t("webPanels.settings.full", { max: MAX_WEB_PANELS }) : t("webPanels.settings.help")}
        </p>
      </div>
    </Card>
  );
}
