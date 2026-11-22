import { type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { type InstanceInfo, type Message } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { CHATGPT_USAGE_URL, ManageUsageLink } from "./ChatGptPlanStatus";
import { CODEX_USAGE_URL, codexUsageLimitReached } from "../../shared/codex-usage-limit";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { claudeUpdateTarget, failedTurnCause, failedTurnNotice, signedOutEngine } from "@/lib/failed-turn";
import { plainErrorLine } from "@/lib/plain-error";
import { openPlaceAction, placeRowViewFor, usePlaceSeat } from "@/lib/place-view";
import type { PlaceRow } from "../../shared/place-view";
import { trialCreditKind, type TrialCreditRefusal } from "../../shared/trial-credit";
import { TrialCreditNotice } from "./TrialCreditNotice";
import { PartlyDoneRow } from "./PartlyDoneRow";
import type { LocaleKey } from "@/locales";
import { isProviderSafetyBlock, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { THIS_COMPUTER_NOT_READY } from "../../shared/your-computer";
import { useLimitResetContinue, usePastLimitNotice } from "./EngineUsage";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { useFailedTurnFix } from "./FailedTurnFix";
import { t } from "@/lib/i18n";

export function ErrorRow({
  message,
  headline: plainHeadline,
  onRetry,
  action, control,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  headline?: string;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void } | null; /** a setting's own control that fixes this failure, below the row's action */ control?: ReactNode;
  setupInstance?: InstanceInfo;
  claudeUpdateInstance?: InstanceInfo;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const failedPermissions = missingMacCuaPermissions(message);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const macCuaReason = ready && capabilities.host.platform === "darwin" &&
    capabilities.localComputer.available === false && capabilities.localComputer.reasonCode !== "remote-server" &&
    message.startsWith(THIS_COMPUTER_NOT_READY) &&
    failedPermissions.length > 0 && failedPermissions.join(",") === currentPermissions.join(",")
    ? macCuaPermissionMessage(currentPermissions)
    : null;
  const headline = macCuaReason ?? plainHeadline ?? message;
  const usageUrl = action ? null : message.includes("subscription_sharing_usage_limit_exceeded") ? CHATGPT_USAGE_URL : codexUsageLimitReached(message) ? CODEX_USAGE_URL : null;
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{headline}</span>
        </div>
        {headline !== message && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{macCuaReason ? t("computer.mac.permission.driverDetail") : t("chat.error.details")}</summary><p className="mt-1 break-words">{message}</p></details>}
        {macCuaReason &&
          <MacCuaRecoveryActions reason={message} />}
        {usageUrl ? (
          <ManageUsageLink href={usageUrl} className="ui-button ui-button-md mt-2 border-transparent bg-ink text-app hover:brightness-110" />
        ) : claudeUpdateInstance ? (
          <ClaudeUpdatePrompt instance={claudeUpdateInstance} onRetry={onRetry} />
        ) : isProviderSafetyBlock(message) ? (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            {t("chat.providerSafety.guidance")}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline">{t("chat.providerSafety.about")}</a>
          </p>
        ) : setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : action !== undefined ? (
          action && (
            <button
              type="button"
              onClick={action.onClick}
              className="ui-button ui-button-md mt-1.5 rounded-full border-danger/30 bg-transparent text-danger interaction:bg-danger/15"
            >
              {action.label}
            </button>
          )
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="ui-button ui-button-md mt-1.5 rounded-full border-danger/30 bg-transparent text-danger interaction:bg-danger/15"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}{control}
      </div>
    </div>
  );
}

function PlaceFailedRow({ place, botId, threadId, onRetry }: {
  place: PlaceRow;
  botId: string;
  threadId?: string;
  onRetry?: () => void;
}) {
  const dispatch = useStoreDispatch(), config = useStoreSelector((state) => state.config);
  const { capabilities } = useDesktopCapabilities();
  const seat = usePlaceSeat(config, capabilities);
  const view = placeRowViewFor(place, seat);
  const id = view.action?.id;
  const onClick = !id ? undefined
    : id === "try-again" ? onRetry
    : () => { openPlaceAction(id, { botId, threadId }, dispatch); };
  return <ErrorRow message={view.line} action={view.action && onClick ? { label: view.action.label, onClick } : null} />;
}

const TRIAL_CREDIT_LINE: Record<"paused" | "too_low", LocaleKey> = { paused: "engines.trialCreditPaused", too_low: "engines.trialCreditTooLow" };
function TrialCreditFailedRow({ kind, onRetry }: { kind: TrialCreditRefusal; onRetry?: () => void }) {
  const dispatch = useStoreDispatch();
  if (kind === "used_up" || kind === "ended") return <TrialCreditNotice kind={kind} />;
  if (kind === "paused") return <ErrorRow message={t(TRIAL_CREDIT_LINE[kind])} onRetry={onRetry} />;
  return <ErrorRow message={t(TRIAL_CREDIT_LINE[kind])} action={{ label: t("chat.error.connectOwnAi"), onClick: () => dispatch({ type: "toggleAppSettings", open: true, section: "engines" }) }} />;
}

export function FailedTurnRow({ tool, engine, onRetry, botId, threadId, messageAt }: { tool: NonNullable<Message["tool"]>; engine: InstanceInfo | undefined; onRetry?: () => void; botId?: string; threadId?: string; messageAt?: number }) {
  const resume = useLimitResetContinue(botId, threadId, tool.limitResetsAt), fix = useFailedTurnFix(tool, botId, threadId);
  const past = usePastLimitNotice(tool, messageAt);
  if (tool.place && botId) return <PlaceFailedRow place={tool.place} botId={botId} threadId={threadId} onRetry={onRetry} />;
  const credit = trialCreditKind(failedTurnCause(tool.name) ?? "");
  if (credit) return <TrialCreditFailedRow kind={credit} onRetry={onRetry} />;
  const { cause, notice } = failedTurnNotice(tool);
  if (tool.partial) return <PartlyDoneRow cause={notice ?? cause} onRetry={onRetry} />;
  if (past) return past;
  const signedOut = signedOutEngine(tool, engine);
  return (
    <ErrorRow
      message={notice ?? cause}
      headline={signedOut ? t("chat.error.signedOut", { name: signedOut.displayName }) : notice ?? plainErrorLine(cause)}
      onRetry={onRetry}
      action={resume ?? fix.action} control={fix.control}
      setupInstance={tool.setup ? engine : undefined}
      claudeUpdateInstance={tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}
    />
  );
}
