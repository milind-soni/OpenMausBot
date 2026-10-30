import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Crown, Pencil, Sparkles, Wand2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { emailGateDone } from "@/lib/analytics";
import { useAdvancedMode } from "@/lib/interface-mode";
import { DEFAULT_BOT_NAME, myDefaultBot, setWelcomingBot, useViewerEmail } from "@/lib/default-bot";
import { landInSidebar } from "@/lib/mausbot-landing";
import { firstReplyPending } from "@/lib/corner-popup";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { welcomeDue, welcomeFinishedThisLaunch, type WelcomeViewer } from "@/lib/onboarding";
import { useStore, type Bot } from "@/state/store";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { BotAvatar } from "./Avatar";
import { useAvatarImage } from "./avatar-editing";
import { MausBotCustomize } from "./MausBotCustomize";
import { usePrefersReducedMotion } from "./mascot-clock";

const LOOK = ["name", "color", "mascotBody", "avatarUrl", "avatarCrop", "avatarZoom", "avatarFocusX", "avatarFocusY"] as const;
export type WelcomeDraft = Pick<Bot, (typeof LOOK)[number]>;
const RECEDE_MS = 240;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

export const welcomeName = (name: string): string => name.trim().slice(0, BOT_PROFILE_LIMITS.name) || DEFAULT_BOT_NAME;

export function draftOf(bot: Bot): WelcomeDraft {
  return { name: bot.name, color: bot.color, mascotBody: bot.mascotBody ?? "cursor", avatarUrl: bot.avatarUrl ?? null,
    avatarCrop: bot.avatarCrop ?? "mascot", avatarZoom: bot.avatarZoom, avatarFocusX: bot.avatarFocusX, avatarFocusY: bot.avatarFocusY };
}

/** What either choice saves, as the bot's own edit screen would: what the person changed, and that they chose. Add puts
 * MausBot at the top of the sidebar; Not now turns "Show MausBot in the sidebar" off. */
export function welcomePatch(bot: Bot, draft: WelcomeDraft, add: boolean): Partial<Bot> {
  const was = draftOf(bot);
  const now: WelcomeDraft = { ...draft, name: welcomeName(draft.name) };
  const changed = Object.fromEntries(LOOK.filter((key) => now[key] !== was[key]).map((key) => [key, now[key]]));
  return { ...changed, welcomed: true, sidebarHidden: !add, ...(add ? { pinned: true } : {}) };
}

/** Once per person and place, never over the first-run welcome or its tour. */
export function mausBotWelcomeDue(input: { bot: Pick<Bot, "welcomed" | "hidden"> | undefined; onboardingDue: boolean; welcomeOpen: boolean; tourOpen: boolean }): boolean {
  return Boolean(input.bot && !input.bot.welcomed && !input.bot.hidden && !input.onboardingDue && !input.welcomeOpen && !input.tourOpen);
}

/** MausBot's first-launch card is due now (mausBotWelcomeDue), and, like the Cloud Pro popup and the product-updates
 * question, waits for the first reply (unknown until the bots load), for a launch after the one whose welcome finished, and
 * for a launch the notices queue has not already used. The notices queue asks this too, so the card goes first. */
export function useMausBotWelcomeDue(viewer: WelcomeViewer | null): { bot: Bot | undefined; due: boolean } {
  const { state } = useStore();
  const bot = myDefaultBot(state.bots, useViewerEmail());
  // The app tour runs only when Settings starts it; one never taken does not hold this back.
  const touring = state.tourOpen;
  const onboardingDue = !viewer || welcomeDue(state.config, {
    remoteClient: window.ogb?.remoteClient?.active === true, legacyDone: emailGateDone(),
    hosted: viewer.hosted, canSave: viewer.canSave, cloudHome: viewer.cloudHome,
  });
  const due = Boolean(state.config) && mausBotWelcomeDue({ bot, onboardingDue, welcomeOpen: state.welcomeOpen, tourOpen: touring })
    && firstReplyPending(state) === false && !welcomeFinishedThisLaunch() && launchDialogShown() !== "notices";
  return { bot, due };
}

export function MausBotWelcome({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state } = useStore();
  const { bot, due: ready } = useMausBotWelcomeDue(viewer);
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const due = !closed && ready;
  useEffect(() => {
    if (!due || !bot) return;
    markLaunchDialog("mausbot");
    setShownFor(bot.id);
  }, [due, bot]);
  useEffect(() => {
    if (!shownFor || closed) return;
    setWelcomingBot(shownFor);
    return () => setWelcomingBot(null);
  }, [shownFor, closed]);
  const shown = shownFor && !closed ? state.bots.find((candidate) => candidate.id === shownFor) : undefined;
  if (!shown) return null;
  return createPortal(<MausBotWelcomeCard bot={shown} onClose={() => setClosed(true)} />, document.body);
}

export function MausBotWelcomeCard({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { dispatch } = useStore();
  const advanced = useAdvancedMode();
  const reduced = usePrefersReducedMotion();
  const [draft, setDraft] = useState<WelcomeDraft>(() => draftOf(bot));
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLSpanElement>(null);
  const pictureRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const name = welcomeName(draft.name);
  const preview: Bot = { ...bot, ...draft, name };
  const edit = (patch: Partial<WelcomeDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const image = useAvatarImage(preview, edit);
  useEffect(() => { dialogRef.current?.focus(); }, []);
  useEffect(() => { if (editing) nameRef.current?.focus(); }, [editing]);

  const recede = () => {
    const motion = reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.97)" }];
    const fade = dialogRef.current?.animate(motion, { duration: reduced ? 150 : RECEDE_MS, easing: EASE, fill: "forwards" });
    overlayRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 150 : RECEDE_MS, easing: "linear", fill: "forwards" });
    if (fade) { fade.onfinish = onClose; fade.oncancel = onClose; } else onClose();
  };

  const choose = (add: boolean) => {
    if (leaving) return;
    setLeaving(true);
    const patch = welcomePatch(bot, draft, add);
    const commit = () => { setWelcomingBot(null); dispatch({ type: "updateBot", botId: bot.id, patch }); };
    if (add) landInSidebar({ from: avatarRef.current, botId: bot.id, reduced, commit });
    else commit();
    recede();
  };

  // Escape decides nothing about the sidebar, but the card has been seen: it is shown once per person and place.
  const dismiss = () => {
    if (leaving) return;
    setLeaving(true);
    setWelcomingBot(null);
    dispatch({ type: "updateBot", botId: bot.id, patch: { welcomed: true } });
    onClose();
  };

  const drop = (event: DragEvent) => {
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    event.preventDefault();
    setEditing(true);
    void image.upload(file);
  };

  return (
    <div ref={overlayRef} className={cn("fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-6 pb-6 pt-[min(6vh,48px)]", advanced ? "bg-black/55" : "ui-scrim", leaving && "pointer-events-none")} data-mausbot-welcome="">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mausbot-welcome-title"
        tabIndex={-1}
        style={{ outline: "none" }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (editing && panelRef.current?.contains(event.target as Node)) { setEditing(false); pictureRef.current?.focus(); } else dismiss();
        }}
        className={cn("animate-pop-in w-full max-w-[460px] rounded-2xl px-6 pb-5 pt-5", advanced ? "border border-hairline/50 bg-panel shadow-2xl" : "ui-modal border-0")}
      >
        <div className="flex flex-col items-center text-center">
          <button
            ref={pictureRef}
            type="button"
            aria-label={t("mausbotWelcome.customize", { name })}
            aria-expanded={editing}
            aria-controls="mausbot-welcome-panel"
            data-mausbot-welcome-picture=""
            onClick={() => setEditing(!editing)}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={drop}
            className="group relative rounded-full p-1 transition-transform duration-200 ease-out hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <span className="pointer-events-none absolute inset-1 rounded-full ring-0 ring-accent/35 transition-[box-shadow] duration-200 group-hover:ring-2 group-focus-visible:ring-2" aria-hidden="true" />
            <span ref={avatarRef} data-mausbot-welcome-avatar="" className="block drop-shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
              <BotAvatar bot={preview} size={96} label={name} motion="arrive" />
            </span>
            <span aria-hidden="true" className="absolute bottom-2 right-2 flex size-7 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary shadow-sm transition-colors group-hover:text-ink">
              <Pencil size={13} />
            </span>
          </button>
          <h2 id="mausbot-welcome-title" className={cn("mt-3 text-ink", advanced ? "text-[20px] font-semibold" : "text-[17px] font-medium leading-6 tracking-[-0.008em]")}>{t("mausbotWelcome.title", { name })}</h2>
          <ul className="mt-3 space-y-1.5 text-left text-[14px] leading-snug text-ink-secondary">
            {([[Sparkles, "mausbotWelcome.line.helper"], [BookOpen, "mausbotWelcome.line.knows"], [Wand2, "mausbotWelcome.line.setup"], [Crown, "mausbotWelcome.line.powers"]] as const).map(([Icon, key]) => (
              <li key={key} className="flex items-start gap-2.5"><Icon size={15} className="mt-0.5 shrink-0 text-ink-tertiary" aria-hidden="true" />{t(key)}</li>
            ))}
          </ul>
        </div>

        <div
          id="mausbot-welcome-panel"
          ref={panelRef}
          inert={!editing}
          aria-hidden={!editing}
          data-mausbot-welcome-panel={editing ? "open" : "closed"}
          className={cn("grid transition-[grid-template-rows,opacity] duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            editing ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="pt-4">
              <MausBotCustomize preview={preview} name={draft.name} nameRef={nameRef} image={image} onName={(next) => edit({ name: next })} onPatch={edit} />
            </div>
          </div>
        </div>

        <div className={cn("mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center", advanced ? "sm:justify-between" : "sm:justify-end")}>
          <button type="button" data-mausbot-welcome-later="" onClick={() => choose(false)} title={t("mausbotWelcome.notNowHint", { name })}
            className={advanced ? "rounded-full px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink" : "ui-button ui-button-pill"}>
            {t("mausbotWelcome.notNow")}
          </button>
          <button type="button" data-mausbot-welcome-add="" onClick={() => choose(true)}
            className={advanced ? "rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-accent-ink hover:brightness-110" : "ui-button ui-button-pill ui-button-primary"}>
            {t("mausbotWelcome.add", { name })}
          </button>
        </div>
      </div>
    </div>
  );
}
