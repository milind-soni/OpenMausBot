import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Cloud, Copy, Download, Monitor, MoreHorizontal, Search, Upload, X } from "lucide-react";
import appsClip from "@/assets/whats-new/apps-dark.mp4";
import appsStill from "@/assets/whats-new/apps-dark.webp";
import teamDark from "@/assets/whats-new/team-dark.mp4";
import teamDarkStill from "@/assets/whats-new/team-dark.webp";
import teamLight from "@/assets/whats-new/team-light.mp4";
import teamLightStill from "@/assets/whats-new/team-light.webp";
import { cn } from "@/lib/cn";
import { useColorScheme } from "@/lib/color-scheme";
import { t } from "@/lib/i18n";
import { reducedMotion } from "@/lib/onboarding";
import { newCloudUrl, startTeamUrl, type PlanSlide, type WhatsNewAction, type WhatsNewSlide, type WhatsNewView } from "@/lib/whats-new";
import type { LocaleKey } from "@/locales";
import { CLOSE, PRIMARY, QUIET, SHEET } from "../cloud-buy/parts";
import { BotAvatar } from "../Avatar";
import { LinkButton, NotNowButton } from "../NoticeCard";
import { TogetherChoice } from "../TogetherChoice";

export const WHATS_NEW_POPUP = "[data-whats-new]";

const TITLES: Record<WhatsNewSlide, LocaleKey> = {
  apps: "whatsNew.apps.title", publish: "whatsNew.publish.title", pro: "whatsNew.cloud.title", cloudNews: "whatsNew.cloudNews.title",
  team: "whatsNew.team.title", teamNews: "whatsNew.teamNews.title", together: "together.notice.title",
};
/** A slide's words; Apps and Publish name the screen, section and menu items as the app labels them. */
function body(slide: WhatsNewSlide, view: WhatsNewView): string {
  switch (slide) {
    case "apps": return t(view.apps?.install ? "whatsNew.apps.body" : "whatsNew.apps.bodyHere",
      { screen: t("publishedApps.title"), section: t(view.apps?.place === "cloud" ? "localApps.section.cloud" : "localApps.section.computer") });
    case "publish": return t("whatsNew.publish.body", { item: t("template.publish"), publish: t("template.publishToCommunity") });
    case "pro": return t("whatsNew.cloud.body");
    case "cloudNews": return t("whatsNew.cloudNews.body");
    case "team": return t("whatsNew.team.bodyInbox");
    case "teamNews": return t("whatsNew.teamNews.body");
    case "together": return t("together.notice.body");
  }
}
/** Slides that only tell: they offer no Not now, and the last slide, when it is one, ends with Got it. */
const TELLING: readonly WhatsNewSlide[] = ["publish", "together", "cloudNews", "teamNews"];
type Clip = { video: string; still: string };
type Clips = { label: LocaleKey; focus: string; dark: Clip; light: Clip };
/** `focus`: where a clip's pointer clicks, kept in view when a taller slide crops the clip's sides. */
const TEAM_CLIP: Clips = { label: "whatsNew.team.videoLabel", focus: "object-[40%_50%]", dark: { video: teamDark, still: teamDarkStill }, light: { video: teamLight, still: teamLightStill } };
/** The apps screen was filmed in the dark look only. */
const APPS_CLIP: Clip = { video: appsClip, still: appsStill };
const PICTURES: Record<"apps" | "team" | "teamNews", Clips> = {
  apps: { label: "whatsNew.apps.videoLabel", focus: "object-[6%_50%]", dark: APPS_CLIP, light: APPS_CLIP },
  team: TEAM_CLIP, teamNews: TEAM_CLIP,
};
const TEAM_POINTS: readonly LocaleKey[] = ["whatsNew.team.apps", "whatsNew.team.groupChats", "whatsNew.team.memory", "whatsNew.team.handoff", "whatsNew.team.accessUse"];
const NAV = "ui-button ui-button-pill min-h-9 gap-1 px-3";

const focusLost = (focus: Element | null) => !focus || focus === document.body || !focus.isConnected;
const titleId = (slide: WhatsNewSlide) => `whats-new-${slide}-title`;
const controls = (popup: Element | null) => [...(popup?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])].filter(button => !button.closest("[inert]"));

/** A slide's short loop of the app itself, at least half as tall as it is wide; it fills the room a taller slide leaves, so
 * every slide is one height, cropping the clip's sides around where it clicks. It plays only on the slide on screen;
 * elsewhere, and wherever motion is reduced, its still. */
function Picture({ slide, active }: { slide: WhatsNewSlide; active: boolean }) {
  if (slide === "together") return <TogetherPicture />;
  if (slide === "publish") return <PublishPicture />;
  if (slide === "cloudNews" || slide === "pro") return <CloudPicture slide={slide} />;
  return <ClipPicture slide={slide} active={active} />;
}

const DRAWN = "relative grid aspect-[2/1] shrink-0 grow place-items-center overflow-hidden bg-ink/[0.035] [@media(max-height:600px)]:hidden";
const DRAWN_CARD = "rounded-xl border-[0.5px] border-ink/10 bg-app shadow-sm";

/** The bot's menu with Publish, drawn from the app's own labels. */
const PUBLISH_ROWS = [[Search, "chat.find"], [Upload, "template.publish"], [Copy, "chat.export.copy"], [Download, "chat.export.download"]] as const;
function PublishPicture() {
  return <div data-whats-new-picture="publish" aria-hidden="true" className={DRAWN}>
    <div className="flex w-[58%] min-w-[220px] flex-col items-end gap-1.5">
      <span className={cn(DRAWN_CARD, "grid size-8 place-items-center rounded-full text-ink")}><MoreHorizontal size={16} /></span>
      <div className={cn(DRAWN_CARD, "flex w-full flex-col gap-0.5 p-1.5")}>
        {PUBLISH_ROWS.map(([Icon, label]) => <div key={label} className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]",
          label === "template.publish" ? "bg-ink/[0.06] font-medium text-ink" : "text-ink-secondary")}>
          <Icon size={15} className="shrink-0" /><span className="min-w-0 truncate">{t(label)}</span>
        </div>)}
      </div>
    </div>
  </div>;
}

/** My Cloud, drawn: a picture of the plans would go stale with each change to how they are sold. */
function CloudPicture({ slide }: { slide: "pro" | "cloudNews" }) {
  return <div data-whats-new-picture={slide} aria-hidden="true" className={DRAWN}>
    <div className="flex flex-col items-center gap-2.5">
      <span className="grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent"><Cloud size={26} /></span>
      <span className="text-[13px] font-medium text-ink">{t("cloudSetup.myCloud")}</span>
    </div>
  </div>;
}

/** Bots of both places in one list, as the sidebar now shows them: drawn, not a clip, so it is the same in every language. */
const TOGETHER_ROWS = [["Ledger", "orange", "computer"], ["Scout", "blue", "cloud"], ["Git Tasks", "teal", "computer"], ["Atlas", "green", "cloud"]] as const;
function TogetherPicture() {
  return <div data-whats-new-picture="together" aria-hidden="true" className={DRAWN}>
    <div className={cn(DRAWN_CARD, "flex w-[64%] min-w-[220px] flex-col gap-0.5 p-1.5")}>
      {TOGETHER_ROWS.map(([name, color, home]) => <div key={name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink">
        <BotAvatar bot={{ name, color }} size={20} state="happy" animated={false} label="" />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-tertiary">
          {home === "cloud" ? <Cloud size={12} /> : <Monitor size={12} />}{t(home === "cloud" ? "cloudSetup.myCloud" : "rail.thisComputer")}
        </span>
      </div>)}
    </div>
  </div>;
}

function ClipPicture({ slide, active }: { slide: keyof typeof PICTURES; active: boolean }) {
  const scheme = useColorScheme();
  const { label, focus, ...clips } = PICTURES[slide], clip = clips[scheme === "dark" ? "dark" : "light"];
  const fill = cn("absolute inset-0 size-full select-none object-cover", focus);
  return <div data-whats-new-picture={slide} className="relative aspect-[2/1] shrink-0 grow overflow-hidden bg-ink/[0.035] [@media(max-height:600px)]:hidden">
    {active && !reducedMotion()
      ? <video src={clip.video} poster={clip.still} autoPlay muted loop playsInline disablePictureInPicture aria-label={t(label)} className={fill} />
      : <img src={clip.still} alt={t(label)} decoding="async" draggable={false} className={fill} />}
  </div>;
}

/**
 * What's new after an update, one slide at a time: Next and Back, its dots, the arrow keys. Focus
 * starts at a slide's title and stays inside; Escape (while focus is inside), ×, a click outside, Not now and Got it end it,
 * and so does every button that opens something. `report` counts each slide seen once and each step. `onBuy` opens the
 * app's own Add a Cloud for a slide: Get Pro, and Start a Team for someone with a plan of their own, whom the website's Get
 * Team would only tell to write in. `onOpenApps` opens Published apps.
 */
export function WhatsNewPopup({ view, report, onBuy, onOpenApps, onDone }: {
  view: WhatsNewView; report: (action: WhatsNewAction, slide: WhatsNewSlide) => void; onBuy: (slide: PlanSlide) => void; onOpenApps?: () => void; onDone: () => void;
}) {
  const [at, setAt] = useState(0);
  const slide = view.slides[at] ?? view.slides[0]!, count = view.slides.length;
  const [seen] = useState(() => new Set<WhatsNewSlide>());
  const end = (action: WhatsNewAction) => { report(action, slide); onDone(); };
  const go = (to: number) => {
    if (to === at || to < 0 || to >= count) return;
    report(to > at ? "next" : "back", slide);
    setAt(to);
  };
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, mine = document.querySelector(WHATS_NEW_POPUP);
    return () => {
      const focus = document.activeElement;
      if ((focusLost(focus) || mine?.contains(focus)) && opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, []);
  useEffect(() => {
    if (!seen.has(slide)) { seen.add(slide); report("seen", slide); }
    document.getElementById(titleId(slide))?.focus();
  }, [slide]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const popup = document.querySelector(WHATS_NEW_POPUP), focus = document.activeElement, inside = Boolean(focus && popup?.contains(focus));
      if (!inside && !(event.key === "Tab" && focusLost(focus)) && !(event.key === "Escape" && focusLost(focus))) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); end("close"); return; }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const forward = (event.key === "ArrowRight") !== (document.dir === "rtl");
        event.preventDefault(); go(at + (forward ? 1 : -1));
        return;
      }
      if (event.key !== "Tab") return;
      const list = controls(popup);
      if (!list.length) return;
      event.preventDefault();
      const index = list.indexOf(focus as HTMLElement), step = event.shiftKey ? -1 : 1;
      list[index === -1 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const buy = (of: PlanSlide) => { report(of === "pro" ? "get_pro" : "start_team", of); onBuy(of); onDone(); };
  const team = view.team ?? { kind: "start", inApp: view.audience === "own" };
  const actions = (of: WhatsNewSlide): ReactNode => of === "apps"
    ? onOpenApps && <button type="button" data-whats-new-open-apps className={cn(PRIMARY, "ui-button-lg")} onClick={() => { end("open_apps"); onOpenApps(); }}>{t("whatsNew.apps.open")}</button>
    : of === "pro"
    ? <>
      <button type="button" className={cn(PRIMARY, "ui-button-lg")} onClick={() => buy("pro")}>{t("cloudBuy.card.get", { plan: view.plans.pro?.name ?? "Pro" })}</button>
      <LinkButton url={newCloudUrl(view.staging)} label={t("whatsNew.cloud.see")} className={cn(QUIET, "ui-button-lg gap-1.5")} onOpened={() => end("see_cloud")} />
    </>
    : TELLING.includes(of) ? (of === view.slides[count - 1] ? <button type="button" data-whats-new-got-it className={cn(PRIMARY, "ui-button-lg")} onClick={() => end("got_it")}>{t("together.notice.done")}</button> : null)
    : team.kind === "invite"
      ? <LinkButton url={team.url} label={t("teamsNew.invite")} className={cn(PRIMARY, "ui-button-lg gap-1.5")} onOpened={() => end("invite")} />
      : team.inApp
        ? <button type="button" className={cn(PRIMARY, "ui-button-lg")} onClick={() => buy("team")}>{t("whatsNew.team.start")}</button>
        : <LinkButton url={startTeamUrl(view.staging)} label={t("whatsNew.team.start")} className={cn(PRIMARY, "ui-button-lg gap-1.5")} onOpened={() => end("start_team")} />;

  return <div className="ui-scrim fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) end("close"); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={titleId(slide)} data-whats-new={slide} tabIndex={-1}
      className={cn(SHEET, "group/sheet animate-pop-in relative flex max-h-full w-full max-w-[520px] flex-col overflow-hidden outline-none")}>
      <div className="grid min-h-0 overflow-y-auto overflow-x-hidden">
        {view.slides.map((of, index) => {
          const here = index === at, shown = actions(of);
          return <section key={of} role="group" aria-label={t("whatsNew.slideOf", { n: index + 1, count })} inert={!here} data-whats-new-slide={of}
            className={cn("flex flex-col [grid-area:1/1] transition-[opacity,transform,visibility] duration-300 ease-out motion-reduce:transition-none",
              here ? "visible translate-x-0 opacity-100" : cn("invisible opacity-0", index < at ? "-translate-x-6 rtl:translate-x-6" : "translate-x-6 rtl:-translate-x-6"))}>
            <Picture slide={of} active={here} />
            <div className="flex flex-col px-6 pt-5">
              <p className="text-[12px] font-medium uppercase leading-4 tracking-[0.06em] text-ink-tertiary">{t("whatsNew.eyebrow")}</p>
              <h2 id={titleId(of)} tabIndex={-1} className="mt-1 text-[19px] font-semibold leading-6 tracking-[-0.012em] text-ink outline-none! [text-wrap:balance]">{t(TITLES[of])}</h2>
              <p className="mt-2 text-[14px] leading-5 text-ink-secondary [text-wrap:pretty]">{body(of, view)}</p>
              {of === "together" && <div className="mt-3"><TogetherChoice id="whats-new-together" /></div>}
              {of === "team" && <ul className="mt-3 flex flex-col gap-1.5 text-[13px] leading-[18px] text-ink">
                {TEAM_POINTS.map(point => <li key={point} className="flex items-start gap-2"><Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-tertiary" aria-hidden="true" />{t(point)}</li>)}
              </ul>}
              {shown && <div className={cn("flex flex-wrap items-start gap-2", of === "together" ? "mt-2" : "mt-5")}>{shown}</div>}
              {(of === "pro" || of === "team") && view.plans[of] && <p className="mt-2.5 text-[12px] leading-4 text-ink-tertiary">{view.plans[of]!.terms}</p>}
            </div>
          </section>;
        })}
      </div>
      <div className="mt-4 flex items-center gap-3 border-t-[0.5px] border-ink/10 px-4 py-2.5">
        {TELLING.includes(slide) ? <span className="min-h-9" /> : <NotNowButton onClick={() => end("not_now")} />}
        {count > 1 && <>
          <div className="flex flex-1 items-center justify-center gap-1.5">
            {view.slides.map((of, index) => <button key={of} type="button" aria-label={t("whatsNew.slideOf", { n: index + 1, count })} aria-current={index === at ? "true" : undefined}
              onClick={() => go(index)} className="grid size-6 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-focus">
              <span aria-hidden="true" className={cn("block h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none", index === at ? "w-4 bg-ink" : "w-1.5 bg-ink/25")} />
            </button>)}
          </div>
          <div className="flex items-center gap-1.5">
            {at > 0 && <button type="button" className={NAV} onClick={() => go(at - 1)}><ArrowLeft size={14} aria-hidden="true" className="rtl:-scale-x-100" />{t("whatsNew.back")}</button>}
            {at < count - 1 && <button type="button" className={NAV} onClick={() => go(at + 1)}>{t("whatsNew.next")}<ArrowRight size={14} aria-hidden="true" className="rtl:-scale-x-100" /></button>}
          </div>
        </>}
      </div>
      <button type="button" onClick={() => end("close")} aria-label={t("cloudAdd.close")}
        className={cn(CLOSE, "absolute end-3 top-3 z-10 bg-app/80 backdrop-blur-sm")}><X size={16} /></button>
    </div>
  </div>;
}
