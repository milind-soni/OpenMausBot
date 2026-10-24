import { NEWLINE_KEYS, newlineKeyConflict, newlineKeyLabel, parseNewlineKey, setNewlineKey, useNewlineKey } from "@/lib/newline-key";
import { parseSteerKey, setSteerKey, shortcutConflict, STEER_KEYS, steerKeyLabel, useSteerKey } from "@/lib/steer-key";
import { parseSendKey, SEND_KEYS, sendKeyLabel, setSendKey, useSendKey } from "@/lib/send-key";
import { t } from "@/lib/i18n";
import { Select } from "./Select";
import { SettingRow } from "./SettingsPrimitives";

export function ComposerShortcutSettings() {
  const sendKey = useSendKey();
  const steerKey = useSteerKey();
  const newlineKey = useNewlineKey();
  return (
    <>
      <SettingRow title={t("settings.newlineKey.title")} subtitle={t("settings.newlineKey.subtitle")}>
        <Select size="sm" className="w-full max-w-[240px]" value={newlineKey}
          aria-label={t("settings.newlineKey.title")}
          onChange={event => setNewlineKey(parseNewlineKey(event.target.value))}>
          {NEWLINE_KEYS.map(key => <option key={key} value={key} disabled={newlineKeyConflict(key, sendKey, steerKey)}>
            {key === "auto" ? t("settings.newlineKey.auto") : newlineKeyLabel(key)}
          </option>)}
        </Select>
      </SettingRow>
      <SettingRow title={t("settings.sendKey.title")} subtitle={newlineKey !== "auto" ? t("settings.sendKey.customSubtitle") : steerKey === "off" ? t("settings.sendKey.subtitle", { key: sendKeyLabel("mod-enter") }) : t("settings.sendKey.steerSubtitle")}>
        <Select size="sm" className="w-full max-w-[240px]"
          value={sendKey}
          aria-label={t("settings.sendKey.title")}
          onChange={(event) => setSendKey(parseSendKey(event.target.value))}
        >
          {SEND_KEYS.map((mode) => (
            <option key={mode} value={mode} disabled={shortcutConflict(mode, steerKey) || newlineKeyConflict(newlineKey, mode)}>{sendKeyLabel(mode)}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow title={t("settings.steerKey.title")} subtitle={t("settings.steerKey.subtitle")}>
        <Select size="sm" className="w-full max-w-[240px]" value={steerKey}
          aria-label={t("settings.steerKey.title")}
          onChange={event => setSteerKey(parseSteerKey(event.target.value))}>
          {STEER_KEYS.map(key => <option key={key} value={key} disabled={shortcutConflict(sendKey, key) || newlineKeyConflict(newlineKey, undefined, key)}>
            {key === "off" ? t("settings.steerKey.off") : steerKeyLabel(key)}
          </option>)}
        </Select>
      </SettingRow>
    </>
  );
}
