import { usbPhoneTakeoverEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { useConfigSave } from "./BrowserSettingsRows";
import { MoreText, SettingRow, Switch } from "./SettingsPrimitives";

/** features.usbPhoneTakeover. Shown only where the server reports the flag: one with no USB port leaves it out. */
export function UsbPhoneTakeoverSettings() {
  const { state } = useStore();
  const on = usbPhoneTakeoverEnabled(state.config);
  const { saving, error, save } = useConfigSave();
  if (state.config?.features?.usbPhoneTakeover === undefined) return null;

  return (
    <div data-testid="usb-phone-takeover-settings" className="contents">
      <SettingRow title={t("settings.experimental.usbPhoneTakeover")} tag={t("settings.early.tag")}
        subtitle={<MoreText short={t("settings.experimental.usbPhoneTakeoverShort")} long={t("settings.experimental.usbPhoneTakeoverDetail")} />}
        message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Switch
          checked={on}
          aria-label={t("settings.experimental.usbPhoneTakeover")}
          disabled={saving}
          onClick={() => void save({ features: { usbPhoneTakeover: !on } })}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </SettingRow>
    </div>
  );
}
