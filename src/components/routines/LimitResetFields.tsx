import type { LimitResetRepeat } from "../../../shared/limit-reset";
import { t } from "@/lib/i18n";
import { engineName, resetTime, useEngineLimits } from "@/lib/limit-resets";
import { Select } from "../Select";

export interface LimitResetChoice { engine: string; repeat: LimitResetRepeat }

/** The editor's "When my AI limit resets": which AI, once or each time, and when that is if it is known. */
export function LimitResetFields({ value, botEngine, onChange }: { value: LimitResetChoice; botEngine?: string; onChange: (next: LimitResetChoice) => void }) {
  const limits = useEngineLimits();
  const engine = value.engine || botEngine || limits[0]?.engine || "";
  const choices = [...new Set([...(botEngine ? [botEngine] : []), ...limits.map((limit) => limit.engine), ...(engine ? [engine] : [])])];
  const reset = limits.find((limit) => limit.engine === engine)?.resetsAt ?? null;
  return (
    <div className="space-y-2 text-[13px] text-ink" data-testid="limit-reset-fields">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("routines.limitReset.engine")}</span>
        <Select aria-label={t("routines.limitReset.engine")} value={engine} onChange={(event) => onChange({ ...value, engine: event.target.value })}>
          {choices.map((id) => <option key={id} value={id}>{engineName(id)}</option>)}
        </Select>
        <Select aria-label={t("routines.limitReset.repeat")} value={value.repeat} onChange={(event) => onChange({ ...value, engine, repeat: event.target.value as LimitResetRepeat })}>
          <option value="once">{t("routines.limitReset.once")}</option>
          <option value="every_reset">{t("routines.limitReset.every")}</option>
        </Select>
      </div>
      <div className="text-[12px] text-ink-secondary">
        {reset !== null && reset > Date.now() ? t("routines.limitReset.next", { time: resetTime(reset) }) : t("routines.limitReset.unknown")}
      </div>
    </div>
  );
}
