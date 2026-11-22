import { useId } from "react";

import { CHECK_WORK_ROUNDS } from "../../../shared/check-work";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { Select } from "../Select";
import { Switch } from "../SettingsPrimitives";

const OWN_THREAD = "";

/** Check before done, in Advanced's Model section: a switch, and once it is on, who checks. */
export function CheckWorkSetting({ bot }: { bot: Bot }) {
  const dispatch = useStoreDispatch();
  const others = useStoreSelector((state) => state.bots.filter((other) => other.id !== bot.id && !other.hidden).map((other) => `${other.id}\u0000${other.name}`).join("\n"));
  const pickerId = useId();
  const on = Boolean(bot.checkWork);
  const set = (checkWork: Bot["checkWork"]) => dispatch({ type: "updateBot", botId: bot.id, patch: { checkWork } });
  const toggle = () => set(on ? null : {});
  const help = t("botSettings.checkWork.help", { checks: CHECK_WORK_ROUNDS, fixes: CHECK_WORK_ROUNDS - 1 });
  const picker = on && (
    <label htmlFor={pickerId} className="mt-3 flex items-center gap-3 text-[13px] text-ink-secondary">
      <span className="shrink-0">{t("botSettings.checkWork.checker")}</span>
      <Select id={pickerId} size="sm" className="min-w-0 max-w-[260px]" value={bot.checkWork?.checker ?? OWN_THREAD}
        onChange={(event) => set(event.target.value === OWN_THREAD ? {} : { checker: event.target.value })}>
        <option value={OWN_THREAD}>{t("botSettings.checkWork.ownThread")}</option>
        {others.split("\n").filter(Boolean).map((entry) => {
          const [id, name] = entry.split("\u0000") as [string, string];
          return <option key={id} value={id}>{name}</option>;
        })}
      </Select>
    </label>
  );
  return (
    <div className="rounded-xl bg-card p-4" data-check-work>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{t("botSettings.checkWork.title")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{help}</div>
        </div>
        <Switch checked={on} aria-label={t("botSettings.checkWork.title")} onClick={toggle} />
      </div>
      {picker}
    </div>
  );
}
