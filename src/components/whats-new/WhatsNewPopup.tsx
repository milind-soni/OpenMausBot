import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import cloudHomeDark from "@/assets/whats-new/cloud-home-dark.webp";
import cloudHomeLight from "@/assets/whats-new/cloud-home-light.webp";
import { cn } from "@/lib/cn";
import { useColorScheme } from "@/lib/color-scheme";
import { t } from "@/lib/i18n";
import { newCloudUrl, startTeamUrl, type WhatsNewAction, type WhatsNewSlide, type WhatsNewView } from "@/lib/whats-new";
import type { LocaleKey } from "@/locales";
import { CLOSE, PRIMARY, QUIET, SHEET } from "../cloud-buy/parts";
import { LinkButton, NotNowButton } from "../NoticeCard";
import { TeamPicture } from "./TeamPicture";

export const WHATS_NEW_POPUP = "[data-whats-new]";

const WORDS: Record<WhatsNewSlide, { title: LocaleKey; body: LocaleKey }> = {
  pro: { title: "whatsNew.cloud.title", body: "whatsNew.cloud.body" },
  team: { title: "whatsNew.team.title", body: "whatsNew.team.body" },
};
const TEAM_POINTS: readonly LocaleKey[] = ["whatsNew.team.apps", "whatsNew.team.groupChats", "whatsNew.team.memory", "whatsNew.team.handoff", "whatsNew.team.access"];
const NAV = "ui-button ui-button-pill min-h-9 gap-1 px-3";

const focusLost = (focus: Element | null) => !focus || focus === document.body || !focus.isConnected;
const titleId = (slide: WhatsNewSlide) => `whats-new-${slide}-title`;
const controls = (popup: Element | null) => [...(popup?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])].filter(button => !button.closest("[inert]"));

/** A slide's picture, at least half as tall as it is wide; the new Cloud's grows into the room the taller Team slide leaves,
 * showing more of the page, centered once all of it fits. */
function Picture({ slide, active }: { slide: WhatsNewSlide; active: boolean }) {
  const scheme = useColorScheme();
  return <div data-whats-new-picture={slide} className="relative aspect-[2/1] shrink-0 grow overflow-hidden bg-ink/[0.035] [@media(max-height:600px)]:hidden">
    {slide === "pro"
      ? <div className="absolute inset-0 flex flex-col items-center px-[4%] pt-3.5">
        <img src={scheme === "dark" ? cloudHomeDark : cloudHomeLight} alt={t("whatsNew.cloud.pictureAlt")} width={1120} height={762} decoding="async" draggable={false}
          className="my-auto w-full max-w-none select-none" />
      </div>
      : <TeamPicture active={active} />}
  </div>;
}

/**
 * What's new after an update, one slide at a time: Next and Back, its dots, the arrow keys. Focus
 * starts at a slide's title and stays inside; Escape (while focus is inside), ×, a click outside and Not now end it, and so
 * does every button that opens something. `report` counts each slide seen once and each step. `onBuy` opens the app's own
 * Add a Cloud for a slide: Get Pro, and Start a Team for someone with a plan of their own, whom the website's Get Team
 * would only tell to write in.
 */
export function WhatsNewPopup({ view, report, onBuy, onDone }: {
  view: WhatsNewView; report: (action: WhatsNewAction, slide: WhatsNewSlide) => void; onBuy: (slide: WhatsNewSlide) => void; onDone: () => void;
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

  const buy = (of: WhatsNewSlide) => { report(of === "pro" ? "get_pro" : "start_team", of); onBuy(of); onDone(); };
  const actions = (of: WhatsNewSlide): ReactNode => of === "pro"
    ? <>
      <button type="button" className={cn(PRIMARY, "ui-button-lg")} onClick={() => buy("pro")}>{t("cloudBuy.card.get", { plan: view.plans.pro?.name ?? "Pro" })}</button>
      <LinkButton url={newCloudUrl(view.staging)} label={t("whatsNew.cloud.see")} className={cn(QUIET, "ui-button-lg gap-1.5")} onOpened={() => end("see_cloud")} />
    </>
    : view.audience === "own"
      ? <button type="button" className={cn(PRIMARY, "ui-button-lg")} onClick={() => buy("team")}>{t("whatsNew.team.start")}</button>
      : <LinkButton url={startTeamUrl(view.staging)} label={t("whatsNew.team.start")} className={cn(PRIMARY, "ui-button-lg gap-1.5")} onOpened={() => end("start_team")} />;

  return <div className="ui-scrim fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) end("close"); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={titleId(slide)} data-whats-new={slide} tabIndex={-1}
      className={cn(SHEET, "group/sheet animate-pop-in relative flex max-h-full w-full max-w-[520px] flex-col overflow-hidden outline-none")}>
      <div className="grid min-h-0 overflow-y-auto overflow-x-hidden">
        {view.slides.map((of, index) => {
          const here = index === at;
          return <section key={of} role="group" aria-label={t("whatsNew.slideOf", { n: index + 1, count })} inert={!here} data-whats-new-slide={of}
            className={cn("flex flex-col [grid-area:1/1] transition-[opacity,transform,visibility] duration-300 ease-out motion-reduce:transition-none",
              here ? "visible translate-x-0 opacity-100" : cn("invisible opacity-0", index < at ? "-translate-x-6 rtl:translate-x-6" : "translate-x-6 rtl:-translate-x-6"))}>
            <Picture slide={of} active={here} />
            <div className="flex flex-col px-6 pt-5">
              <p className="text-[12px] font-medium uppercase leading-4 tracking-[0.06em] text-ink-tertiary">{t("whatsNew.eyebrow")}</p>
              <h2 id={titleId(of)} tabIndex={-1} className="mt-1 text-[19px] font-semibold leading-6 tracking-[-0.012em] text-ink outline-none! [text-wrap:balance]">{t(WORDS[of].title)}</h2>
              <p className="mt-2 text-[14px] leading-5 text-ink-secondary [text-wrap:pretty]">{t(WORDS[of].body)}</p>
              {of === "team" && <ul className="mt-3 flex flex-col gap-1.5 text-[13px] leading-[18px] text-ink">
                {TEAM_POINTS.map(point => <li key={point} className="flex items-start gap-2"><Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-tertiary" aria-hidden="true" />{t(point)}</li>)}
              </ul>}
              <div className="mt-5 flex flex-wrap items-start gap-2">{actions(of)}</div>
              {view.plans[of] && <p className="mt-2.5 text-[12px] leading-4 text-ink-tertiary">{view.plans[of]!.terms}</p>}
            </div>
          </section>;
        })}
      </div>
      <div className="mt-4 flex items-center gap-3 border-t-[0.5px] border-ink/10 px-4 py-2.5">
        <NotNowButton onClick={() => end("not_now")} />
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
