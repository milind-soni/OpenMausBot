import { ShieldCheck } from "lucide-react";
import { useId } from "react";

import { CHECK_WORK_ROUNDS } from "../../../shared/check-work";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { Select } from "../Select";
import { Switch } from "../SettingsPrimitives";
import { rowCls, SwitchRow } from "../bot-panel/rows";

const OWN_THREAD = "";

/** Check before done: a switch, and once on, who checks. `card` sits in Advanced's Model section, `row` under the
 * Simple panel's model rows. */
export function CheckWorkSetting({ bot, variant }: { bot: Bot; variant: "card" | "row" }) {
  const dispatch = useStoreDispatch();
  const others = useStoreSelector((state) => state.bots.filter((other) => other.id !== bot.id && !other.hidden).map((other) => `${other.id}\u0000${other.name}`).join("\n"));
  const pickerId = useId();
  const on = Boolean(bot.checkWork);
  const set = (checkWork: Bot["checkWork"]) => dispatch({ type: "updateBot", botId: bot.id, patch: { checkWork } });
  const toggle = () => set(on ? null : {});
  const help = t("botSettings.checkWork.help", { rounds: CHECK_WORK_ROUNDS });
  const picker = on && (
    <label htmlFor={pickerId} className={cn("flex items-center gap-3 text-[13px] text-ink-secondary", variant === "row" ? cn(rowCls, "pt-0") : "mt-3")}>
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
  if (variant === "row") return (
    <div data-panel-row="check-work">
      <SwitchRow icon={ShieldCheck} title={t("botSettings.checkWork.title")} hint={help} checked={on} onChange={toggle} color={bot.color} />
      {picker}
    </div>
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
