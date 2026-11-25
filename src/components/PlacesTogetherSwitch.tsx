import { useState } from "react";
import { t } from "@/lib/i18n";
import { setPlacesTogether, usePlacesTogether } from "@/lib/places-together";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";

/** Settings → MausBot Cloud: this computer's bots and My Cloud's in one sidebar. Shown only where main offers it;
 * My Cloud's page can turn it off, and only this computer's page turns it on. */
export function PlacesTogetherSwitch() {
  const together = usePlacesTogether();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  if (!together?.available || (!together.on && together.here !== "computer")) return null;
  const turn = () => {
    setBusy(true); setFailed(false);
    void setPlacesTogether(!together.on).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  return <SettingsGroup block="together">
    <SettingsRows>
      <div data-places-together={together.on ? "on" : "off"} className="contents">
        <SettingRow title={t("together.switch.title")} tag={t("settings.early.tag")} subtitle={`${t("together.switch.line")} ${t("together.switch.commands")}`}
          message={failed ? <span role="alert" className="block text-danger">{t("together.switch.failed")}</span> : undefined}>
          <Switch checked={together.on} disabled={busy} aria-label={t("together.switch.title")} onClick={turn} />
        </SettingRow>
      </div>
    </SettingsRows>
  </SettingsGroup>;
}
