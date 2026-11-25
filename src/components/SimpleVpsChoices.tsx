import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { CloudBackend } from "../../shared/wire";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { Switch } from "./SettingsPrimitives";

export function SimpleVpsChoices({ bot, backend, onBackend, onAutoStart }: {
  bot: Bot;
  backend: CloudBackend;
  onBackend: (backend: CloudBackend) => void;
  onAutoStart: () => void;
}) {
  return (
    <div data-testid="vps-choices">
      <CloudBackendPicker compact value={backend} onChange={onBackend} />
      {!bot.computer && (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">{t("botAccess.cloud.startVps")}</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">{t("botAccess.cloud.startVpsDescription")}</div>
          </div>
          <Switch checked={Boolean(bot.autoStartVps)} aria-label={t("botAccess.cloud.startVps")} onClick={onAutoStart} />
        </div>
      )}
    </div>
  );
}
