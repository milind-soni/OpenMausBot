import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsRows, Switch } from "./SettingsPrimitives";

export function AgentCursorOverlayRow() {
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.agentCursorOverlay;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.get().then(value => { if (active) setEnabled(value); }).catch(() => {});
    return () => { active = false; };
  }, [bridge]);

  if (!bridge || enabled === null) return null;
  const title = t("computer.mac.agentCursor.title");
  const toggle = async () => {
    setSaving(true);
    setFailed(false);
    try {
      setEnabled(await bridge.set(!enabled));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return <SettingsRows>
    <SettingRow title={title} subtitle={t("computer.mac.agentCursor.subtitle")}
      message={failed && <span role="alert">{t("computer.mac.agentCursor.saveFailed")}</span>}>
      <Switch checked={enabled} aria-label={title} disabled={saving} onClick={() => void toggle()} />
    </SettingRow>
  </SettingsRows>;
}
