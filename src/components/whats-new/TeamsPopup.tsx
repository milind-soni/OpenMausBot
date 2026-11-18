import { useEffect, type CSSProperties } from "react";
import { Bot, FolderOpen, Lock, X } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausColor } from "@/lib/mascot";
import { reducedMotion } from "@/lib/onboarding";
import type { TeamsAction, TeamsStep } from "@/lib/teams-whats-new";
import type { LocaleKey } from "@/locales";
import { CLOSE, PRIMARY, SHEET } from "../cloud-buy/parts";
import { LinkButton, NotNowButton } from "../NoticeCard";

export const TEAMS_POPUP = "[data-teams-popup]";
const TITLE = "teams-popup-title";

const POINTS: readonly { icon: typeof Bot; text: LocaleKey }[] = [
  { icon: Bot, text: "teamsNew.sharedBot" },
  { icon: FolderOpen, text: "teamsNew.files" },
  { icon: Lock, text: "teamsNew.private" },
];
/** Made-up teammates who join the one shared bot, two on each side; each comes in from further out. */
const FACES: readonly { name: string; color: MausColor; x: number; y: number }[] = [
  { name: "Ada", color: "purple", x: -92, y: -26 },
  { name: "Ben", color: "teal", x: -76, y: 30 },
  { name: "Cleo", color: "coral", x: 92, y: -26 },
  { name: "Dara", color: "blue", x: 76, y: 30 },
];

const focusLost = (focus: Element | null) => !focus || focus === document.body || !focus.isConnected;

/** One bot in the middle and four teammates joining it, one after another while motion is allowed (styles.css
 * teams-face-in); still and complete without it. */
function TeamsPicture() {
  const animated = !reducedMotion();
  return <div aria-hidden="true" data-teams-picture="" className="relative h-[132px] shrink-0 overflow-hidden bg-ink/[0.035] [@media(max-height:560px)]:hidden">
    <div className="absolute left-1/2 top-1/2 size-0">
      <span className="absolute -left-[60px] -top-[60px] size-[120px] rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-accent)_16%,transparent),transparent_70%)]" />
      <span className="absolute -left-7 -top-7"><MausAvatar color="chrome" size={56} state="idle" animated={animated} trackPointer={false} /></span>
      {FACES.map((face, index) => <span key={face.name} data-teams-face={face.name}
        className="teams-face-in absolute flex size-9 items-center justify-center rounded-full text-[14px] font-semibold ring-2 ring-app"
        style={{ left: face.x - 18, top: face.y - 18, color: `var(--identity-${face.color})`, background: `color-mix(in srgb, var(--identity-${face.color}) 22%, var(--color-card))`,
          "--face": index, "--from-x": `${Math.sign(face.x) * 14}px` } as CSSProperties}>{face.name[0]}</span>)}
    </div>
  </div>;
}

/**
 * "MausBot is better with your team": once per person after this release (AppNotices), and again from Announcements.
 * Focus starts at its main button and stays inside; Escape, ×, a click outside and every button end it.
 */
export function TeamsPopup({ action, onStep, onStart, onDone }: {
  action: TeamsAction;
  onStep: (step: TeamsStep) => void;
  /** Start a team in the app's own Add a Cloud (action.inApp). */
  onStart: () => void;
  onDone: () => void;
}) {
  const end = (step: TeamsStep) => { onStep(step); onDone(); };
  useEffect(() => {
    onStep("seen");
    const opener = document.activeElement as HTMLElement | null, mine = document.querySelector(TEAMS_POPUP);
    mine?.querySelector<HTMLElement>("[data-primary] button, button[data-primary]")?.focus();
    return () => {
      const focus = document.activeElement;
      if ((focusLost(focus) || mine?.contains(focus)) && opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const popup = document.querySelector(TEAMS_POPUP), focus = document.activeElement;
      if (!popup || (!popup.contains(focus) && !focusLost(focus))) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); end("close"); return; }
      if (event.key !== "Tab") return;
      const list = [...popup.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (!list.length) return;
      event.preventDefault();
      const at = list.indexOf(focus as HTMLElement), step = event.shiftKey ? -1 : 1;
      list[at === -1 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const main = action.kind === "invite"
    ? <LinkButton url={action.url} label={t("teamsNew.invite")} className={cn(PRIMARY, "ui-button-lg gap-1.5")} onOpened={() => end("invite")} />
    : action.kind === "got-it"
      ? <button type="button" className={cn(PRIMARY, "ui-button-lg")} onClick={() => end("got_it")}>{t("teamsNew.gotIt")}</button>
      : action.inApp
        ? <button type="button" className={cn(PRIMARY, "ui-button-lg")} onClick={() => { onStart(); end("start_team"); }}>{t("teamsNew.start")}</button>
        : <LinkButton url={action.url} label={t("teamsNew.start")} className={cn(PRIMARY, "ui-button-lg gap-1.5")} onOpened={() => end("start_team")} />;

  return <div className="ui-scrim fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) end("close"); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={TITLE} data-teams-popup={action.kind} tabIndex={-1}
      className={cn(SHEET, "teams-card-in relative flex max-h-full w-full max-w-[460px] flex-col overflow-hidden outline-none")}>
      <div className="flex min-h-0 flex-col overflow-y-auto">
        <TeamsPicture />
        <div className="flex flex-col px-6 pb-5 pt-5">
          <p className="text-[12px] font-medium uppercase leading-4 tracking-[0.06em] text-ink-tertiary">{t("whatsNew.eyebrow")}</p>
          <h2 id={TITLE} className="mt-1 text-[19px] font-semibold leading-6 tracking-[-0.012em] text-ink [text-wrap:balance]">{t("teamsNew.title")}</h2>
          <ul className="mt-3 flex flex-col gap-2 text-[14px] leading-5 text-ink">
            {POINTS.map(({ icon: Icon, text }) => <li key={text} className="flex items-start gap-2.5">
              <span className="mt-px flex size-[18px] shrink-0 items-center justify-center text-ink-secondary"><Icon size={16} strokeWidth={1.75} aria-hidden="true" /></span>
              <span className="[text-wrap:pretty]">{t(text)}</span>
            </li>)}
          </ul>
          <p data-teams-price className="mt-3 text-[13px] leading-[18px] text-ink-secondary">{t("teamsNew.price")}</p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div data-primary="">{main}</div>
            {action.kind !== "got-it" && <NotNowButton onClick={() => end("not_now")} />}
          </div>
        </div>
      </div>
      <button type="button" onClick={() => end("close")} aria-label={t("cloudAdd.close")}
        className={cn(CLOSE, "absolute end-3 top-3 z-10 bg-app/80 backdrop-blur-sm")}><X size={16} /></button>
    </div>
  </div>;
}
