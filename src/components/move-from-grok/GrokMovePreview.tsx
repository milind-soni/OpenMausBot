import { BookOpen, CalendarClock, Loader2, NotebookPen, Plug, Users, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Footer, PRIMARY, StepHeading } from "@/components/cloud-welcome/parts";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { takeImportName } from "../../../shared/import-name";
import type { GrokMovePlan, GrokNote } from "../../../shared/grok-import";

const SHOWN = 6;

export interface GrokMovePending {
  plans: GrokMovePlan[];
  /** Pieces of text that looked like a key and were taken out. */
  redacted: number;
  /** Routines a Bot's chat announced that its export left out. */
  missing: Array<{ bot: string; routines: string[] }>;
}

function Section({ icon: Icon, title, count, rule, children }: { icon: LucideIcon; title: string; count: number; rule?: string; children?: ReactNode }) {
  return (
    <section className="rounded-2xl bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-text"><Icon size={15} /></span>
        <h3 className="min-w-0 flex-1 text-[15px] font-medium text-ink">{title}</h3>
        <span className="shrink-0 text-[13px] tabular-nums text-ink-secondary">{count || t("grokMove.preview.none")}</span>
      </div>
      {count > 0 && rule && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{rule}</p>}
      {count > 0 && children}
    </section>
  );
}

/** Names first; a long list opens on one tap. */
function Names({ items }: { items: ReadonlyArray<ReactNode> }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-relaxed text-ink">
        {shown.map((item, index) => <li key={index} className="break-words">{item}</li>)}
      </ul>
      {items.length > SHOWN && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-1.5 text-[13px] font-medium text-accent-text hover:underline">
          {t("grokMove.preview.showAll", { count: items.length })}
        </button>
      )}
    </>
  );
}

const noteLine = (note: GrokNote) => t(`grokMove.note.${note.kind}` as LocaleKey, "name" in note ? { name: note.name } : {});

/** Second screen: every category with its count and names, and plainly what stays behind. Nothing is written yet. */
export function GrokMovePreview({ pending, takenNames, adding, error, onAdd }: {
  pending: GrokMovePending;
  takenNames: readonly string[];
  adding: boolean;
  error: string;
  onAdd: () => void;
}) {
  const { plans } = pending;
  const taken = new Set(takenNames.map((name) => name.trim().toLowerCase()));
  const newNames = plans.map((plan) => takeImportName(plan.name, taken));
  const skills = plans.flatMap((plan) => plan.skills);
  const routines = plans.flatMap((plan) => plan.routines);
  const webhooks = plans.flatMap((plan) => plan.webhooks);
  const rebuild = plans.flatMap((plan) => plan.rebuild);
  const memories = plans.flatMap((plan) => plan.memories);
  const servers = plans.flatMap((plan) => plan.servers);
  const apps = plans.flatMap((plan) => plan.apps);
  const notes = plans.flatMap((plan) => plan.notes);
  const behind: ReactNode[] = [
    ...rebuild.map((routine) => t(routine.reason === "event" ? "grokMove.preview.rebuildEvent" : "grokMove.preview.rebuildSchedule", { name: routine.name, trigger: routine.trigger || routine.when })),
    ...notes.map(noteLine),
    ...pending.missing.map((item) => t("grokMove.preview.missing", { bot: item.bot, routines: item.routines.join(", ") })),
    ...(pending.redacted ? [t("grokMove.preview.redacted", { count: pending.redacted })] : []),
  ];
  return (
    <section aria-labelledby="grok-move-title" data-grok-move-step="preview" className="flex flex-col gap-3">
      <div className="mb-2"><StepHeading id="grok-move-title" title={t("grokMove.preview.title")} sub={t("grokMove.preview.sub")} /></div>

      <Section icon={Users} title={t("grokMove.preview.bots")} count={plans.length}>
        <ul className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed">
          {plans.map((plan, index) => (
            <li key={plan.name}>
              <span className="font-medium text-ink">{newNames[index]}</span>
              {plan.title && <span className="text-ink-secondary"> · {plan.title}</span>}
              {newNames[index] !== plan.name && <span className="block text-ink-secondary">{t("grokMove.preview.renamed", { name: plan.name })}</span>}
              {plan.instructions && <span className="mt-0.5 line-clamp-2 block text-ink-secondary">{plan.instructions}</span>}
            </li>
          ))}
        </ul>
      </Section>
      <Section icon={BookOpen} title={t("grokMove.preview.skills")} count={skills.length} rule={t("grokMove.preview.skillsRule")}>
        <Names items={skills} />
      </Section>
      <Section icon={CalendarClock} title={t("grokMove.preview.routines")} count={routines.length + webhooks.length} rule={t("grokMove.preview.routinesRule")}>
        <Names items={[
          ...routines.map((routine) => <>{routine.name}<span className="text-ink-secondary"> · {routine.when} ({routine.timeZone})</span></>),
          ...webhooks.map((webhook) => <>{webhook.name}<span className="text-ink-secondary"> · {t("grokMove.preview.webhook")}</span></>),
        ]} />
      </Section>
      <Section icon={NotebookPen} title={t("grokMove.preview.memories")} count={memories.length}>
        <Names items={memories} />
      </Section>
      <Section icon={Plug} title={t("grokMove.preview.apps")} count={servers.length + apps.length} rule={t("grokMove.preview.appsRule")}>
        <Names items={[
          ...servers.map((server) => <>{server.name}{server.values.length > 0 && <span className="text-ink-secondary"> · {t("grokMove.preview.serverNeeds", { values: server.values.join(", ") })}</span>}</>),
          ...apps.map((app) => <>{app}<span className="text-ink-secondary"> · {t("grokMove.preview.appSignIn")}</span></>),
        ]} />
      </Section>

      <section data-grok-move-behind className="rounded-2xl border border-hairline/50 p-4">
        <h3 className="text-[15px] font-medium text-ink">{t("grokMove.preview.behind")}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{t("grokMove.preview.behindAlways")}</p>
        {behind.length > 0 && <Names items={behind} />}
      </section>

      {error && <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>}
      <Footer className="mt-2">
        <button type="button" data-grok-move-add disabled={adding} onClick={onAdd} className={`${PRIMARY} inline-flex items-center gap-2`}>
          {adding && <Loader2 size={15} className="animate-spin" />}
          {adding ? t("grokMove.preview.adding") : plans.length === 1 ? t("grokMove.preview.add", { name: newNames[0]! }) : t("grokMove.preview.addMany", { count: plans.length })}
        </button>
      </Footer>
    </section>
  );
}
