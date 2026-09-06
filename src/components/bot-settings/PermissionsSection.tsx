// Permissions: how autonomously this bot acts — the approval level (ask /
// auto / full / custom), review-routine approvals, whether it asks before
// contacting other bots, and whether it holds the section's Chief of Staff
// role. Moved from SettingsPanel.tsx (Chief of Staff ~720-755,
// Ask-before-contacting ~757-776, Approval level ~990-1010, Review routine
// approvals ~1013-1050).
//
// The Auto branch of LocalComputerAutoWarning (choosing Auto while
// bot.computer === "local") and the FullAccessWarning live here with their
// triggers; the Works-on-picker branch (turning computer to "local" while
// already on Auto) stays with AccessSection, next to that picker. The
// warnings remember which bot they were opened for, so a bot switch while
// one is up never applies the choice to the newly selected bot.
import { useState } from "react";
import { Crown } from "lucide-react";

import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import type { ApprovalMode } from "../../../shared/approval-mode";
import { ApprovalModeSelector } from "../ApprovalModeSelector";
import { FullAccessWarning } from "../FullAccessWarning";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { Switch } from "../SettingsPrimitives";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

export function PermissionsSection({
  bot,
  derived,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
}) {
  const { patch, engine, canCoordinate, canAutoReview, approvalMode, trustedModesAvailable, sectionName, currentChief } = derived;
  const { dispatch } = useStore();
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const [fullAccessTarget, setFullAccessTarget] = useState<string | null>(null);
  const setApprovalMode = (mode: ApprovalMode) => {
    if (bot.busy || mode === approvalMode) return;
    if (mode === "full") {
      setFullAccessTarget(bot.id);
      return;
    }
    if (mode === "auto" && bot.computer === "local") {
      setLocalAutoWarning(bot.id);
      return;
    }
    patch({ approvalMode: mode });
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "rounded-xl border p-4",
          bot.chiefOfStaff ? "border-accent/40 bg-accent/10" : "border-hairline/40 bg-card",
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              bot.chiefOfStaff ? "bg-accent text-white" : "bg-control text-ink-secondary",
            )}
          >
            <Crown size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-ink">Chief of Staff</div>
            <div className="text-[11.5px] text-ink-secondary">One for {sectionName}</div>
          </div>
          <Switch
            checked={Boolean(bot.chiefOfStaff)}
            aria-label="Chief of Staff"
            disabled={!bot.chiefOfStaff && !canCoordinate}
            onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
            title={!bot.chiefOfStaff && !canCoordinate ? "This engine cannot contact other bots" : undefined}
            className="disabled:cursor-not-allowed"
          />
        </div>
        <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
          {bot.chiefOfStaff && !canCoordinate
            ? "This bot still holds the role, but its current engine cannot contact teammates. Choose a Claude or ACP engine to restore coordination."
            : bot.chiefOfStaff
              ? `This is the primary contact for ${sectionName}. It can create and coordinate specialists in this section, then combine their work into one answer.`
              : !canCoordinate
                ? "Choose a Claude or ACP engine to let this bot coordinate teammates."
                : currentChief
                  ? `Make this bot the ${sectionName} Chief and hand the role over from ${currentChief.name}.`
                  : `Make this bot the primary contact for the ${sectionName} section.`}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">Ask me before contacting other bots</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {bot.approvePeerComms
              ? "This bot will stop and ask before it reaches out to another bot."
              : "Let this bot talk to teammates on its own, without a confirmation step."}
          </div>
        </div>
        <Switch
          checked={Boolean(bot.approvePeerComms)}
          aria-label="Ask me before contacting other bots"
          disabled={!bot.approvePeerComms && !canCoordinate}
          onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
          title={!bot.approvePeerComms && !canCoordinate ? "This engine cannot contact other bots" : undefined}
          className="disabled:cursor-not-allowed"
        />
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Approval level</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          Choose how much this bot can do before it stops to ask you.
        </div>
        <div className="mt-3">
          <ApprovalModeSelector
            approvalMode={bot.approvalMode}
            autoApprove={bot.autoApprove}
            providerName={engine?.displayName ?? bot.name}
            driverKind={engine?.driverKind ?? ""}
            onSelect={setApprovalMode}
            menuDirection="down"
            wide
            disabled={Boolean(bot.busy)}
            trustedModesAvailable={trustedModesAvailable}
          />
        </div>
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Review routine approvals</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {approvalMode === "custom"
            ? "Custom follows your Codex config.toml and its approval prompts. Routine auto-review stays off in this mode."
            : canAutoReview
              ? "The same engine reviews ordinary approval cards. Existing safety rules, unattended turns, local-computer access, and questions still wait for you."
              : "This engine cannot run an isolated review safely, so approval cards continue to wait for you."}
        </div>
        <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
          {(
            [
              ["off", "Off", "Every undecided approval waits for you."],
              ["shadow", "Watch", "Record the review without answering the card."],
              ["enforce", "On", "Answer only reviews that return a strict approval."],
            ] as const
          ).map(([value, label, hint]) => {
            const current = approvalMode === "custom"
              ? "off"
              : bot.autoReview === "shadow" || bot.autoReview === "enforce"
                ? bot.autoReview
                : "off";
            const disabled = value !== "off" && (approvalMode === "custom" || !canAutoReview);
            return (
              <button
                key={value}
                title={disabled
                  ? approvalMode === "custom"
                    ? "Custom approval behavior is controlled by config.toml"
                    : "Not supported by this engine"
                  : hint}
                disabled={disabled}
                onClick={() => patch({ autoReview: value })}
                className={cn(
                  "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                  current === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
        }}
      />
      <FullAccessWarning
        open={fullAccessTarget !== null}
        onCancel={() => setFullAccessTarget(null)}
        onConfirm={() => {
          const target = fullAccessTarget;
          setFullAccessTarget(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target, patch: { approvalMode: "full", confirmFullAccess: true } });
        }}
      />
    </div>
  );
}
