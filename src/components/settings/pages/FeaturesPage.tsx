import { useState } from "react";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { useFeature, type Feature } from "@/lib/use-feature";
import { api, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "../../SettingsPrimitives";

const COPY: Record<Feature, { title: LocaleKey; line: LocaleKey }> = {
  skillBurger: { title: "settings.features.skillBurger", line: "settings.features.skillBurgerLine" },
  threadTabs: { title: "settings.features.threadTabs", line: "settings.features.threadTabsLine" },
  teamBoard: { title: "settings.features.teamBoard", line: "settings.features.teamBoardLine" },
};

/** One switch kept in this place's config.json; shown once its server says it knows the switch (the board: only a Team Cloud's). */
function FeatureRow({ name }: { name: Feature }) {
  const on = useFeature(name);
  const known = useStoreSelector((state) => typeof state.config?.features?.[name] === "boolean");
  const dispatch = useStoreDispatch();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!known) return null;
  const save = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { [name]: next } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setError(t("settings.features.error"));
    } finally {
      setSaving(false);
    }
  };
  const copy = COPY[name];
  return (
    <SettingRow title={t(copy.title)} subtitle={t(copy.line)} message={error ? <p role="alert" className="text-danger">{error}</p> : null}>
      <Switch data-feature-switch={name} checked={on} aria-label={t(copy.title)} disabled={saving} onClick={() => void save(!on)}
        className="disabled:cursor-wait disabled:opacity-50" />
    </SettingRow>
  );
}

export function FeaturesPage() {
  return (
    <SettingsGroup block="features">
      <SettingsRows>
        <FeatureRow name="skillBurger" />
        <FeatureRow name="threadTabs" />
        <FeatureRow name="teamBoard" />
      </SettingsRows>
    </SettingsGroup>
  );
}
