// Screen 4: the Cloud is set up (about two minutes); meanwhile it gets a name and a colour, then it opens by itself.
import type { CloudColor } from "../../../electron/cloud-buy.mjs";
import type { CloudSetupStep } from "../../../electron/cloud-home.mjs";
import { cn } from "@/lib/cn";
import { CLOUD_COLOR_LABEL, CLOUD_COLORS, CLOUD_NAME_MAX, cloudColorFill } from "@/lib/cloud-look";
import { cloudPlanLabel, usd, type CloudStarted } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ACTIONS, Badge, Checklist, CloudTile, FIELD, Heading, PRIMARY, ProgressBar, QUIET, SCREEN } from "./parts";

const STEPS = [["reserving", "cloudHome.step.reserving"], ["storage", "cloudHome.step.storage"], ["starting", "cloudBuy.step.starting"], ["checking", "cloudHome.step.checking"]] as const satisfies
  ReadonlyArray<readonly [CloudSetupStep, LocaleKey]>;

export function startedBadge({ tier, trial, credit }: CloudStarted, received: boolean): string {
  if (received) return t("cloudAdd.receivedTitle");
  const plan = cloudPlanLabel(tier ?? trial?.tier ?? undefined);
  if (!trial) return t("cloudBuy.setup.badgePaid", { plan });
  return credit ? t("cloudBuy.setup.badgeCredit", { plan, credit: usd(credit.grantedUsd) }) : t("cloudBuy.setup.badgeTrial", { plan });
}

export function SetupScreen({ started, received, step, slow, ready, sleeps = false, name, typed, color, counting, busy, openFailed, onName, onColor, onOpen, onNotNow }: {
  started: CloudStarted; received: boolean; step: CloudSetupStep | null; slow: boolean; ready: boolean;
  /** Its plan sleeps when idle, so the switcher will say so rather than always on. */
  sleeps?: boolean;
  /** The name shown (the default while the field is empty); `typed` is the field. */
  name: string; typed: string; color: CloudColor; counting: number | null; busy: boolean; openFailed: boolean;
  onName: (name: string) => void; onColor: (color: CloudColor) => void; onOpen: () => void; onNotNow: () => void;
}) {
  const at = ready ? STEPS.length : Math.max(0, STEPS.findIndex(([key]) => key === step));
  const plan = cloudPlanLabel(started.tier ?? started.trial?.tier ?? undefined);
  return <div data-cloud-add={ready ? "ready" : received ? "received" : "starting"} data-cloud-setup={ready ? "ready" : step ?? "reserving"} className={SCREEN}>
    <div className="flex flex-col gap-3">
      <Badge>{startedBadge(started, received)}</Badge>
      <Heading title={ready ? t("cloudBuy.ready.title", { name }) : t("cloudBuy.setup.title")}
        sub={ready ? t("cloudBuy.ready.sub") : received ? t("cloudAccount.purchaseNoteNoDate") : t("cloudBuy.setup.sub")} />
    </div>
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="flex flex-col gap-3">
        <ProgressBar value={at / STEPS.length} label={t("cloudBuy.setup.progress")} />
        <Checklist label={t("cloudBuy.setup.progress")} items={STEPS.map(([key, label], index) => ({
          key, title: t(label, { name }),
          state: index < at ? "done" as const : index === at ? "now" as const : "next" as const,
        }))} />
        {slow && !ready && <p role="status" className="px-3 text-[13px] leading-[18px] text-ink-secondary">{t("cloudHome.slow")}</p>}
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cloud-add-name" className="text-[13px] leading-[18px] text-ink-secondary">{t("cloudBuy.setup.name")}</label>
          <input id="cloud-add-name" value={typed} maxLength={CLOUD_NAME_MAX} placeholder={t("cloudSetup.myCloud")} autoComplete="off" spellCheck={false}
            onChange={event => onName(event.target.value)} className={FIELD} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span id="cloud-add-color" className="text-[13px] leading-[18px] text-ink-secondary">{t("cloudBuy.setup.color")}</span>
          <div role="radiogroup" aria-labelledby="cloud-add-color" className="flex flex-wrap gap-2">
            {CLOUD_COLORS.map(option => <button key={option} type="button" role="radio" aria-checked={option === color} aria-label={t(CLOUD_COLOR_LABEL[option])}
              tabIndex={option === color ? 0 : -1} data-color={option} onClick={() => onColor(option)}
              onKeyDown={event => {
                const order = CLOUD_COLORS.indexOf(option), delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
                if (!delta) return;
                event.preventDefault();
                const next = CLOUD_COLORS[(order + delta + CLOUD_COLORS.length) % CLOUD_COLORS.length]!;
                onColor(next);
                event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-color="${next}"]`)?.focus();
              }}
              style={{ background: cloudColorFill(option) }}
              className={cn("size-[26px] rounded-lg border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                option === color ? "border-ink shadow-[inset_0_0_0_2px_var(--color-app)]" : "border-transparent")} />)}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] leading-[18px] text-ink-secondary">{t("cloudBuy.setup.preview")}</span>
          <span data-cloud-preview className="inline-flex max-w-full items-center gap-2 self-start rounded-[12px] border-[0.5px] border-ink/10 bg-menu py-1.5 pe-3 ps-1.5">
            <CloudTile color={color} />
            <span className="min-w-0"><span className="block truncate text-[13px] font-medium leading-4 text-ink">{name}</span>
              <span className="block truncate text-[12px] text-ink-tertiary">{t(sleeps ? "cloudBuy.setup.previewLineSleeps" : "cloudBuy.setup.previewLine", { plan })}</span></span>
          </span>
        </div>
      </div>
    </div>
    {ready && counting === null && <p className="text-[13px] leading-[18px] text-ink-tertiary">{t("cloudBuy.ready.hint", { name })}</p>}
    <div className={ACTIONS}>
      {counting !== null && <span role="status" className="me-1 text-[13px] text-ink-secondary">{t("cloudBuy.setup.openingIn", { seconds: counting })}</span>}
      {counting !== null && <button type="button" className={QUIET} onClick={onNotNow}>{t("notice.notNow")}</button>}
      <button type="button" className={PRIMARY} disabled={!ready || busy} onClick={onOpen}>{t("cloudBuy.setup.open", { name })}</button>
    </div>
    {openFailed && <p role="alert" className="-mt-2 text-end text-[13px] leading-[18px] text-danger">{t("cloudBuy.openFailed", { name })}</p>}
  </div>;
}

/** A Team or Business plan's Cloud while it is set up: the Admin's steps for the team's own machine. It gets no name or
 * colour here: the team's name is the Admin's. */
export function TeamSetupScreen({ team, step, slow }: { team: string | null; step: CloudSetupStep | null; slow: boolean }) {
  const at = Math.max(0, STEPS.findIndex(([key]) => key === step)), name = team ?? t("cloudBuy.team.unnamed");
  return <div data-cloud-add="team-starting" data-cloud-setup={step ?? "reserving"} className={SCREEN}>
    <Heading title={t("cloudBuy.team.setupTitle")} sub={t("cloudBuy.team.setupSub")} />
    <div className="flex flex-col gap-3">
      <ProgressBar value={at / STEPS.length} label={t("cloudBuy.setup.progress")} />
      <Checklist label={t("cloudBuy.setup.progress")} items={STEPS.map(([key, label], index) => ({
        key, title: t(label, { name }), state: index < at ? "done" as const : index === at ? "now" as const : "next" as const,
      }))} />
      {slow && <p role="status" className="px-3 text-[13px] leading-[18px] text-ink-secondary">{t("cloudHome.slow")}</p>}
    </div>
  </div>;
}

/** A Team or Business plan's Cloud, ready: the team's, opened as the switcher opens it. */
export function TeamReadyScreen({ name, busy, openFailed, onOpen }: { name: string; busy: boolean; openFailed: boolean; onOpen: () => void }) {
  return <div data-cloud-add="team-ready" className={SCREEN}>
    <Heading title={t("cloudBuy.team.readyTitle")} sub={t("cloudBuy.team.readySub", { name })} />
    <p className="text-[13px] leading-[18px] text-ink-tertiary">{t("cloudBuy.ready.hint", { name })}</p>
    <div className={ACTIONS}>
      <button type="button" data-autofocus className={PRIMARY} disabled={busy} onClick={onOpen}>{t("cloudBuy.setup.open", { name })}</button>
    </div>
    {openFailed && <p role="alert" className="-mt-2 text-end text-[13px] leading-[18px] text-danger">{t("cloudBuy.openFailed", { name })}</p>}
  </div>;
}
