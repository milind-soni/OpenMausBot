import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from "react";
import { Crown } from "lucide-react";
import { BotAvatar, MausAvatar } from "@/components/Avatar";
import { usePrefersReducedMotion } from "@/components/mascot-clock";
import { cn } from "@/lib/cn";
import { chiefChoices, chiefFor, createChiefPatch, DEFAULT_BOT_NAME, myDefaultBot, setWelcomingBot, stageIntro, useViewerEmail } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import { FLIGHT_MS, landInSidebar } from "@/lib/mausbot-landing";
import { useStore, type Bot } from "@/state/store";

/** Clicks, Enter and Space wait this long after the dialog opens, so a double click on Next never presses Create. */
export const CHIEF_GUARD_MS = 300;
/** The dialog and its scrim fade out (opacity only), and a reduced-motion landing crossfades, over this long. */
export const CHIEF_FADE_MS = 150;
const AVATAR_SIZE = 64;
const SECONDARY = "ui-button ui-button-pill";
const PRIMARY = "ui-button ui-button-pill ui-button-primary";

function ChiefBadge() {
  return (
    <span aria-hidden="true" data-chief-badge="" className="absolute bottom-0 right-0 flex size-4 items-center justify-center rounded-full bg-[#E8993A] text-white ring-2 ring-menu">
      <Crown size={9} strokeWidth={2.5} fill="currentColor" />
    </span>
  );
}

/** Whether a bot's AI can direct other bots, which a Chief of Staff needs. */
function canLead(bot: Bot, instances: ReturnType<typeof useStore>["state"]["instances"]): boolean {
  return Boolean(bot.chiefOfStaff) || instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.agentsMcp === true;
}

/** The first run's second screen, over the empty app: MausBot as the person's Chief of Staff (Create), or, where they
 * already have bots, one of those (Choose, then Confirm). It shows only where no other bot is the Chief (chiefStepFits)
 * and asks for a choice, so Escape leaves only the list. Create flies MausBot onto its sidebar tile; the chat comes when
 * it lands (`onDone`), and `onLeave` fades the scrim with the dialog. */
export function ChiefIntro({ replay, onDone, onLeave }: { replay: boolean; onDone: (botId: string | null) => void; onLeave?: () => void }) {
  const { state, dispatch } = useStore();
  const reduced = usePrefersReducedMotion();
  const viewer = useViewerEmail();
  const maus = myDefaultBot(state.bots, viewer);
  const chief = chiefFor(state.bots, maus);
  const choices = chiefChoices(state.bots, maus, viewer);
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const avatar = useRef<HTMLSpanElement>(null);
  const armed = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => { armed.current = true; }, CHIEF_GUARD_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!maus) return;
    setWelcomingBot(maus.id);
    return () => setWelcomingBot(null);
  }, [maus?.id]);
  useEffect(() => {
    const first = dialog.current?.querySelector<HTMLElement>(choosing ? "[role=radio][tabindex='0']" : "[data-primary]");
    (first ?? dialog.current)?.focus({ preventScroll: true });
  }, [choosing]);

  const early = (event: SyntheticEvent) => {
    if (armed.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  // Opacity only; a timer moves on, since a hidden window runs no animation to its end.
  const leave = (botId: string | null, after: number) => {
    setLeaving(true);
    onLeave?.();
    dialog.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CHIEF_FADE_MS, fill: "forwards" });
    setTimeout(() => onDone(botId), after);
  };

  const create = () => {
    if (leaving || !maus) return;
    const patch = createChiefPatch(maus, chief);
    if (!replay) stageIntro(maus.id);
    landInSidebar({
      from: avatar.current,
      botId: maus.id,
      reduced,
      commit: () => {
        setWelcomingBot(null);
        dispatch({ type: "updateBot", botId: maus.id, patch });
      },
    });
    leave(maus.id, reduced ? CHIEF_FADE_MS : FLIGHT_MS);
  };

  const keep = (bot: Bot) => {
    if (leaving) return;
    setWelcomingBot(null);
    if (maus && !maus.welcomed) dispatch({ type: "updateBot", botId: maus.id, patch: { welcomed: true } });
    if (!bot.chiefOfStaff) dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: true } });
    leave(bot.id, CHIEF_FADE_MS);
  };

  const enabled = choices.filter((bot) => canLead(bot, state.instances));
  const choice = enabled.find((bot) => bot.id === picked);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (choosing) setChoosing(false);
      return;
    }
    if (!choosing || !["ArrowDown", "ArrowUp"].includes(event.key) || !enabled.length) return;
    event.preventDefault();
    const at = enabled.findIndex((bot) => bot.id === picked);
    const next = enabled[(at + (event.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length]!;
    setPicked(next.id);
    dialog.current?.querySelector<HTMLElement>(`[data-chief-choice="${next.id}"]`)?.focus();
  };

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="chief-intro-title"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClickCapture={early}
      onKeyDownCapture={(event) => (event.key === "Enter" || event.key === " ") && early(event)}
      data-chief-intro={choosing ? "choose" : "intro"}
      className={cn("ui-modal animate-pop-in w-[min(440px,calc(100vw-32px))] rounded-[16px] border-0 outline-none", leaving && "pointer-events-none")}
    >
      {choosing ? (
        <div className="p-4">
          <h2 id="chief-intro-title" className="text-[14px] font-medium leading-5 text-ink">{t("onboarding.chief.chooseTitle")}</h2>
          <div role="radiogroup" aria-labelledby="chief-intro-title" className="-mx-2 mt-2 max-h-[282px] overflow-y-auto px-2 [scrollbar-width:thin]">
            {choices.map((bot) => {
              const able = canLead(bot, state.instances);
              const checked = picked === bot.id;
              return (
                <div
                  key={bot.id}
                  role="radio"
                  aria-checked={checked}
                  aria-disabled={!able || undefined}
                  title={able ? undefined : t("sidebar.bot.chiefNeedsEngine")}
                  tabIndex={checked || (!choice && bot.id === enabled[0]?.id) ? 0 : -1}
                  data-chief-choice={bot.id}
                  onClick={() => able && setPicked(bot.id)}
                  onKeyDown={(event) => {
                    if (able && (event.key === " " || event.key === "Enter")) {
                      event.preventDefault();
                      setPicked(bot.id);
                    }
                  }}
                  className={cn("flex min-h-10 items-center gap-2 rounded-lg p-2 transition-colors focus-visible:outline-offset-[-2px]",
                    able ? "cursor-pointer hover:bg-ink/[0.06]" : "opacity-40", checked && "bg-ink/[0.06]")}
                >
                  <BotAvatar bot={bot} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink">{bot.name}</span>
                  <span aria-hidden="true" className={cn("size-4 shrink-0 rounded-full border-[1.5px]",
                    checked ? "border-ink bg-ink shadow-[inset_0_0_0_3px_var(--color-menu)]" : "border-ink/30")} />
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setChoosing(false)} className={SECONDARY}>{t("onboarding.back")}</button>
            <button type="button" data-chief-confirm="" disabled={!choice || leaving} onClick={() => choice && keep(choice)} className={PRIMARY}>
              {t("onboarding.chief.confirm")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center gap-4 px-6 pb-4 pt-6 text-center">
            <span ref={avatar} className="relative flex">
              {maus ? <BotAvatar bot={maus} size={AVATAR_SIZE} motion="arrive" /> : <MausAvatar color="chrome" size={AVATAR_SIZE} label={DEFAULT_BOT_NAME} />}
              <ChiefBadge />
            </span>
            <div className="flex flex-col gap-2">
              <h2 id="chief-intro-title" className="text-[17px] font-medium leading-6 tracking-[-0.008em] text-ink">{t("onboarding.chief.title")}</h2>
              <p className="text-[14px] leading-5 text-ink-secondary">{t("onboarding.chief.body")}</p>
            </div>
          </div>
          <div className={cn("p-4", choices.length > 0 && "grid grid-cols-2 gap-2")}>
            {choices.length > 0 && (
              <button type="button" data-chief-choose="" onClick={() => { setPicked(null); setChoosing(true); }} className={cn(SECONDARY, "min-w-0")}>
                <span className="truncate">{t("onboarding.chief.choose")}</span>
              </button>
            )}
            <button type="button" data-primary="" data-chief-create="" onClick={create} disabled={!maus} className={cn(PRIMARY, "w-full min-w-0")}>
              <span className="truncate">{t("onboarding.chief.create")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
