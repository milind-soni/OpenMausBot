import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "lucide-react";
import { CLOUD_PLAN_URL } from "@/lib/app-links";
import { botRoom, closeBotLimit, useBotLimitOpen } from "@/lib/bot-limit";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { useCloudPlanSnapshot } from "./CloudTrialNotice";
import { NoteLine, UpgradeButton, usageBridge, useUpgrade } from "./CloudUsageMeter";
import { LinkButton, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

const POPUP = "[data-bot-limit-popup]";
const TITLE = "bot-limit-title";
const BODY = "bot-limit-body";
/** Above every dialog a person can press a create button in, and the upgrade's confirmation with it. */
const LAYER = "z-[80]";

export function BotLimitPopup() {
  return useBotLimitOpen() ? <BotLimitDialog onClose={closeBotLimit} /> : null;
}

function BotLimitDialog({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const bridge = usageBridge(state.config?.cloudHome === true);
  const plan = useCloudPlanSnapshot(bridge);
  const usage = plan?.status === "paid" ? plan.usage ?? null : null;
  const [upgraded, setUpgraded] = useState<string | null>(null);
  const [planFailed, setPlanFailed] = useState(false);
  const upgrade = useUpgrade(bridge, usage, "app_usage", setUpgraded, LAYER);
  const confirming = upgrade.confirming;
  // The Admin tells this Cloud about a new plan within a minute; until then the plan page and this Cloud disagree.
  const goingThrough = plan?.tier !== undefined && plan.tier !== "starter";
  const settled = upgraded !== null || goingThrough;
  const limit = state.config?.botLimit;
  const noRoom = limit !== undefined && botRoom(state) === 0;

  useEffect(() => {
    document.querySelector<HTMLElement>(`${POPUP} button`)?.focus();
  }, [plan === null, Boolean(usage), settled]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = document.querySelector<HTMLElement>(POPUP);
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      const controls = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !button.disabled);
      const at = controls.indexOf(document.activeElement as HTMLButtonElement), step = event.shiftKey ? -1 : 1;
      controls[at === -1 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const title = upgraded ? t("usageMeter.done", { plan: cloudPlanLabel(upgraded) })
    : goingThrough ? t("usageMeter.pending")
      : noRoom ? t("botLimit.title", { count: limit }) : t("botLimit.titleTooMany");
  // A person's other Cloud reads its plan but upgrades on its Plan page; a browser tab or a paired device has no bridge at all.
  const inApp = Boolean(bridge && (usage || plan === null));

  return createPortal(<>
    {!confirming && (
      <div className={cn("ui-scrim fixed inset-0 flex items-center justify-center p-4 motion-reduce:animate-none", LAYER)}>
        <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby={settled ? undefined : BODY} data-bot-limit-popup=""
          className="ui-modal animate-pop-in relative flex w-[min(380px,calc(100vw-32px))] flex-col items-center border-0 px-6 pb-3 pt-8 text-center text-ink motion-reduce:animate-none">
          <div aria-hidden="true"><MausAvatar color="chrome" size={52} state="idle" animated={false} /></div>
          <h2 id={TITLE} className="mt-5 text-[19px] font-semibold leading-6 tracking-[-0.012em] [text-wrap:balance]">{title}</h2>
          {!settled && <p id={BODY} className="mt-1.5 text-[14px] leading-5 text-ink-secondary [text-wrap:pretty]">{t(inApp ? "botLimit.body" : "botLimit.bodyElsewhere")}</p>}
          {settled ? (
            <button type="button" onClick={onClose} className={cn(PRIMARY_BUTTON, "mt-5 w-full justify-center")}>{t("roomCard.gotIt")}</button>
          ) : usage ? (
            <div className="mt-5 w-full">
              <UpgradeButton usage={usage} upgrade={{ busy: upgrade.busy, note: upgrade.note, onUpgrade: upgrade.start }} className="w-full justify-center" />
            </div>
          ) : !bridge ? (
            <div className="mt-5 w-full [&>div]:w-full"><LinkButton url={CLOUD_PLAN_URL} label={t("botLimit.openPlan")} className={cn(PRIMARY_BUTTON, "w-full justify-center")} /></div>
          ) : plan !== null ? (
            <button type="button" className={cn(PRIMARY_BUTTON, "mt-5 w-full justify-center")} onClick={() => { setPlanFailed(false); void bridge.manage().then(onClose, () => setPlanFailed(true)); }}>
              {t("botLimit.openPlan")}<ArrowUpRight size={14} aria-hidden="true" />
            </button>
          ) : null}
          {planFailed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("notice.openFailed")}</p>}
          {upgrade.note && !upgraded && <div className="mt-2"><NoteLine note={upgrade.note} /></div>}
          {!settled && <div className="mt-1"><NotNowButton onClick={onClose} /></div>}
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="ui-icon-button absolute end-3 top-3"><X size={16} /></button>
        </div>
      </div>
    )}
    {upgrade.dialog}
  </>, document.body);
}
