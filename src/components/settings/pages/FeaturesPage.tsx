import { useState } from "react";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { setDeviceFeature, type DeviceFeature } from "@/lib/feature-switches";
import { useFeature, type Feature, type PlaceFeature } from "@/lib/use-feature";
import { api, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "../../SettingsPrimitives";
import { useSettingsShell } from "../settings-shell";

const COPY: Record<Feature, { title: LocaleKey; line: LocaleKey }> = {
  skillBurger: { title: "settings.features.skillBurger", line: "settings.features.skillBurgerLine" },
  threadTabs: { title: "settings.features.threadTabs", line: "settings.features.threadTabsLine" },
  threadNotes: { title: "settings.features.threadNotes", line: "settings.features.threadNotesLine" },
  mascotMotion: { title: "settings.features.mascotMotion", line: "settings.features.mascotMotionLine" },
};

function FeatureRow({ name, saving = false, error, onChange }: { name: Feature; saving?: boolean; error?: string; onChange: (on: boolean) => void }) {
  const on = useFeature(name);
  const copy = COPY[name];
  return (
    <SettingRow title={t(copy.title)} subtitle={t(copy.line)} message={error ? <p role="alert" className="text-danger">{error}</p> : null}>
      <Switch data-feature-switch={name} checked={on} aria-label={t(copy.title)} disabled={saving} onClick={() => onChange(!on)}
        className="disabled:cursor-wait disabled:opacity-50" />
    </SettingRow>
  );
}

/** A switch kept in this place's config.json; shown once its server says it knows the switch. */
function PlaceFeatureRow({ name }: { name: PlaceFeature }) {
  const known = useStoreSelector((state) => typeof state.config?.features?.[name] === "boolean");
  const dispatch = useStoreDispatch();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!known) return null;
  const save = async (on: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { [name]: on } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setError(t("settings.features.error"));
    } finally {
      setSaving(false);
    }
  };
  return <FeatureRow name={name} saving={saving} error={error} onChange={(on) => void save(on)} />;
}

const DeviceFeatureRow = ({ name }: { name: DeviceFeature }) => <FeatureRow name={name} onChange={(on) => setDeviceFeature(name, on)} />;

export function FeaturesPage() {
  const { ctx } = useSettingsShell();
  const placeSwitches = !ctx.client && !(ctx.team && !ctx.admin);
  return <>
    {placeSwitches && (
      <SettingsGroup block="features">
        <SettingsRows>
          <PlaceFeatureRow name="skillBurger" />
          <PlaceFeatureRow name="threadTabs" />
        </SettingsRows>
      </SettingsGroup>
    )}
    <SettingsGroup label={t("settings.account.onThisDevice")} block="this-device">
      <SettingsRows>
        <DeviceFeatureRow name="threadNotes" />
        <DeviceFeatureRow name="mascotMotion" />
      </SettingsRows>
    </SettingsGroup>
  </>;
}
