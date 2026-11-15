import { parallelRoomJobsEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { useConfigSave } from "./BrowserSettingsRows";
import { MoreText, SettingRow, Switch } from "./SettingsPrimitives";

export function ParallelRoomJobsSettings() {
  const { state } = useStore();
  const on = parallelRoomJobsEnabled(state.config);
  const { saving, error, save } = useConfigSave();
  if (state.config?.features?.parallelRoomJobs === undefined) return null;

  return (
    <div data-testid="parallel-room-jobs-settings" className="contents">
      <SettingRow title={t("settings.experimental.parallelRoomJobs")} tag={t("settings.early.tag")}
        subtitle={<MoreText short={t("settings.experimental.parallelRoomJobsShort")} long={t("settings.experimental.parallelRoomJobsDetail")} />}
        message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Switch
          checked={on}
          aria-label={t("settings.experimental.parallelRoomJobs")}
          disabled={saving}
          onClick={() => void save({ features: { parallelRoomJobs: !on } })}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </SettingRow>
    </div>
  );
}
