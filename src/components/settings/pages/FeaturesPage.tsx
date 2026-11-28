import { useId, useState } from "react";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { useFeature, type Feature } from "@/lib/use-feature";
import { api, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { Select } from "../../Select";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "../../SettingsPrimitives";

const COPY: Record<Feature, { title: LocaleKey; line: LocaleKey }> = {
  skillBurger: { title: "settings.features.skillBurger", line: "settings.features.skillBurgerLine" },
  threadTabs: { title: "settings.features.threadTabs", line: "settings.features.threadTabsLine" },
  suggestedReplies: { title: "settings.features.suggestedReplies", line: "settings.features.suggestedRepliesLine" },
};

/** One switch kept in this place's config.json; shown once its server says it knows the switch. */
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

type ThreadTitles = NonNullable<ConfigStatus["threadTitles"]>;
type TitleModel = NonNullable<ThreadTitles["model"]>;
type ThreadTitlesPatch = Pick<ThreadTitles, "model"> | Pick<ThreadTitles, "followUp">;

function titleModelKey({ instanceId, model }: TitleModel) {
  return JSON.stringify([instanceId, model]);
}

function ThreadTitleRows() {
  const titles = useStoreSelector((state) => state.config?.threadTitles);
  const instances = useStoreSelector((state) => state.instances);
  const dispatch = useStoreDispatch();
  const id = useId();
  const [feedback, setFeedback] = useState<{ field: "model" | "followUp"; saving: boolean } | null>(null);
  if (!titles) return null;

  const saving = feedback?.saving === true;
  const choices = instances
    .filter((instance) => titles.instances.includes(instance.instanceId) && instance.snapshot.state === "available" && !instance.policy)
    .flatMap((instance) => instance.models.options
      .filter((model) => !model.orgBlocked && !model.needsCliUpdate && (instance.snapshot.authenticated !== false || model.custom))
      .map((model) => {
        const selection = { instanceId: instance.instanceId, model: model.id };
        return {
          key: titleModelKey(selection),
          label: t("settings.features.titleModelChoice", { provider: instance.displayName, model: model.label }),
          selection,
        };
      }));
  const selected = titles.model ? titleModelKey(titles.model) : "";
  const currentChoice = choices.find((choice) => choice.key === selected);
  const unavailable = titles.model && !currentChoice
    ? t("settings.features.titleModelUnavailable", { model: titles.model.model })
    : undefined;
  const automatic = t("settings.features.titleModelAutomatic");
  const modelLabel = t("settings.features.titleModel");
  const followUpLabel = t("settings.features.titleFollowUp");
  const noChoices = !titles.model && choices.length === 0;

  const save = async (threadTitles: ThreadTitlesPatch) => {
    if (saving) return;
    const field = "model" in threadTitles ? "model" : "followUp";
    setFeedback({ field, saving: true });
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ threadTitles }) });
      dispatch({ type: "configStatus", config });
      setFeedback(null);
    } catch {
      setFeedback({ field, saving: false });
    }
  };
  const status = (field: "model" | "followUp") => {
    if (feedback?.field !== field) return undefined;
    return saving ? <span role="status">{t("settings.threads.saving")}</span>
      : <span role="alert" className="text-danger">{t("settings.features.error")}</span>;
  };

  return (
    <>
      <SettingRow title={modelLabel} message={status("model")}
        subtitle={noChoices ? <span id={`${id}-model`}>{t("settings.features.titleModelConnect")}</span> : undefined}>
        <Select aria-label={modelLabel} aria-describedby={noChoices ? `${id}-model` : undefined}
          title={currentChoice?.label ?? unavailable ?? automatic} value={selected} disabled={saving || noChoices}
          onChange={(event) => {
            const key = event.target.value;
            if (key === "") void save({ model: null });
            else {
              const choice = choices.find((option) => option.key === key);
              if (choice) void save({ model: choice.selection });
            }
          }}>
          <option value="">{automatic}</option>
          {unavailable && <option value={selected} disabled>{unavailable}</option>}
          {choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
        </Select>
      </SettingRow>
      <SettingRow title={followUpLabel} subtitle={<span id={`${id}-follow-up`}>{t("settings.features.titleFollowUpLine")}</span>} message={status("followUp")}>
        <Switch checked={titles.followUp} aria-label={followUpLabel} aria-describedby={`${id}-follow-up`}
          disabled={saving} onClick={() => void save({ followUp: !titles.followUp })} />
      </SettingRow>
    </>
  );
}

export function FeaturesPage() {
  return (
    <SettingsGroup block="features">
      <SettingsRows>
        <FeatureRow name="skillBurger" />
        <FeatureRow name="threadTabs" />
        <FeatureRow name="suggestedReplies" />
        <ThreadTitleRows />
      </SettingsRows>
    </SettingsGroup>
  );
}
