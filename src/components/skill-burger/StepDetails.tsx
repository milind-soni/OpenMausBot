import { t } from "@/lib/i18n";

/** What a step keeps beyond its one line: what it was after, the brief a teammate was given, the steps it read, its
 * answer last time and whose step it was. Advanced mode also shows the step's raw call. */
export interface StepDetail {
  note?: string;
  brief?: string;
  reads?: string[];
  example?: string;
  from?: string;
  args?: Record<string, unknown>;
}

export const hasDetail = (detail: StepDetail, advanced: boolean): boolean =>
  Boolean(detail.note || detail.brief || detail.reads?.length || detail.example || detail.from || (advanced && detail.args && Object.keys(detail.args).length));

const HEADING = "text-[11px] font-medium text-ink-tertiary";
const BLOCK = "max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-snug";

/** A step's details, under its line once someone taps it. `id` is what the line's button names in aria-controls. */
export function StepDetails({ id, detail, advanced, open }: { id: string; detail: StepDetail; advanced: boolean; open: boolean }) {
  const args = advanced && detail.args && Object.keys(detail.args).length ? JSON.stringify(detail.args, null, 2) : "";
  return (
    <div id={id} hidden={!open} data-step-details="" className="mt-1.5 flex flex-col gap-1.5 border-t border-hairline/60 pt-1.5 ps-[26px] animate-fade-in motion-reduce:animate-none">
      {detail.note && (
        <div>
          <p className={HEADING}>{t("skillBurger.detail.lookingFor")}</p>
          <p dir="auto" className={BLOCK}>{detail.note}</p>
        </div>
      )}
      {detail.brief && (
        <div>
          <p className={HEADING}>{t("skillBurger.detail.brief")}</p>
          <p dir="auto" className={BLOCK}>{detail.brief}</p>
        </div>
      )}
      {detail.reads?.length ? (
        <div>
          <p className={HEADING}>{t("skillBurger.detail.reads")}</p>
          <p dir="auto" className={BLOCK}>{detail.reads.join(", ")}</p>
        </div>
      ) : null}
      {detail.example && (
        <div>
          <p className={HEADING}>{t("skillBurger.detail.lastTime")}</p>
          <p dir="auto" className={`${BLOCK} text-ink-secondary`}>{detail.example}</p>
        </div>
      )}
      {args && (
        <div>
          <p className={HEADING}>{t("skillBurger.detail.call")}</p>
          <pre dir="ltr" className={`${BLOCK} font-mono text-[11px] text-ink-secondary`}>{args}</pre>
        </div>
      )}
      {detail.from && <p className="text-[11px] text-ink-tertiary">{t("skillBurger.detail.learnedFrom", { name: detail.from })}</p>}
    </div>
  );
}
