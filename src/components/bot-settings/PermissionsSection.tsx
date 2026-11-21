// LocalComputerAutoWarning remembers its bot, so a bot switch while it is up never applies the choice to the new bot.
import { useTeamPeople } from "@/state/team-people";
import { useState } from "react";
import { Crown } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { threadApprovalModes, type Bot } from "@/state/store";
import type { ApprovalMode } from "../../../shared/approval-mode";
import { effectiveOutboundPolicy, type OutboundPolicy } from "../../../shared/outbound";
import { ApprovalModeSelector } from "../ApprovalModeSelector";
import { CommandAllowlistDialog } from "../CommandAllowlistDialog";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { Switch } from "../SettingsPrimitives";
import { ManagedTeamsSettings } from "./ManagedTeamsSettings";
import { ProposalStatus } from "./ProposalStatus";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";
import { sameItems, useStoreDispatch, useStoreSelector } from "@/state/store-select";

export type PermissionsPart = "chief" | "approval" | "outbound";

export function PermissionsSection({
  bot,
  derived,
  parts,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  parts?: readonly PermissionsPart[];
}) {
  const { patch, engine, canCoordinate, approvalMode, trustedModesAvailable, sectionName, currentChief } = derived;
  const team = useTeamPeople();
  const teams = useStoreSelector((s) => ["", ...(s.sections ?? []), ...[...s.bots, ...s.groups].map(member => member.section?.trim() || "")], sameItems), dispatch = useStoreDispatch();
  const ownerOrAdmin = useOwnerOrAdmin();
  const { draft } = useBotEditor();
  const displaySectionName = sectionName === "General" ? t("botAccess.teams.general") : sectionName;
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const [commandAllowlistTarget, setCommandAllowlistTarget] = useState<{ botId: string; botName: string } | null>(null);
  const shows = (part: PermissionsPart) => !parts || parts.includes(part);
  const applyEverywhere = (mode: "ask" | "full") =>
    dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: mode, applyToAllThreads: true } });
  const setApprovalMode = (mode: ApprovalMode) => {
    if (mode === "ask") {
      const threadModes = threadApprovalModes(bot);
      const reachesEveryThread = trustedModesAvailable || !threadModes.includes("custom");
      if (reachesEveryThread && (approvalMode !== "ask" || threadModes.some((threadMode) => threadMode !== "ask"))) applyEverywhere("ask");
      else if (approvalMode !== "ask") patch({ approvalMode: "ask" });
      return;
    }
    if (mode === approvalMode) return;
    if (mode === "auto" && bot.computer === "local") {
      setLocalAutoWarning(bot.id);
      return;
    }
    if (mode === "full") applyEverywhere("full");
    else patch({ approvalMode: mode });
  };

  return (
    <div className="flex flex-col gap-4">
      {shows("chief") && !team && <div
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
            <div className="text-[15px] font-medium text-ink">{t("permissions.chief.title")}</div>
            <div className="text-[12px] text-ink-secondary">{t("permissions.chief.oneFor", { section: displaySectionName })}</div>
          </div>
          <Switch
            checked={Boolean(bot.chiefOfStaff)}
            aria-label={t("permissions.chief.title")}
            disabled={!bot.chiefOfStaff && !canCoordinate}
            onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
            title={!bot.chiefOfStaff && !canCoordinate ? t("permissions.cannotCoordinate") : undefined}
            className="disabled:cursor-not-allowed"
          />
        </div>
        <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
          {bot.chiefOfStaff && !canCoordinate
            ? t("permissions.chief.unsupportedCurrent")
            : bot.chiefOfStaff
              ? t("permissions.chief.active", { section: displaySectionName })
              : !canCoordinate
                ? t("permissions.chief.unsupported")
                : currentChief
                  ? t("permissions.chief.replace", { section: displaySectionName, current: currentChief.name })
                  : t("permissions.chief.make", { section: displaySectionName })}
        </div>
        <ProposalStatus bot={bot} kind="chief" />
        {bot.chiefOfStaff && <ManagedTeamsSettings
          key={bot.id + JSON.stringify(bot.managedSections ?? [])}
          name={bot.name} ownTeam={bot.section?.trim() || ""}
          teams={teams}
          allowed={bot.managedSections ?? []}
          onSave={managedSections => patch({ managedSections, acknowledgePeerScope: true })}
        />}
        {bot.chiefOfStaff && <ProposalStatus bot={bot} kind="owner" />}
      </div>}

      {shows("approval") && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("permissions.approval.title")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {draft ? t("permissions.approval.draftHanded") : t("permissions.approval.helpHanded")}
        </div>
        <ProposalStatus bot={bot} kind="owner" />
        <div className="mt-3">
          <ApprovalModeSelector
            approvalMode={bot.approvalMode}
            autoApprove={bot.autoApprove}
            providerName={engine?.displayName ?? bot.name}
            driverKind={engine?.driverKind ?? ""}
            onSelect={setApprovalMode}
            menuDirection="down"
            wide
            busy={Boolean(bot.busy)}
            trustedModesAvailable={trustedModesAvailable}
            onManageCommandAllowlist={!draft && ownerOrAdmin === true ? () => setCommandAllowlistTarget({ botId: bot.id, botName: bot.name }) : undefined}
          />
        </div>
        {!draft && approvalMode === "full" && <button
          type="button"
          className="mt-3 text-[13px] text-accent hover:underline disabled:opacity-40"
          onClick={() => applyEverywhere("full")}
        >{t("permissions.approval.applyFull")}</button>}
        {!draft && ownerOrAdmin === true && <button
          type="button"
          className="mt-3 block text-[13px] text-accent hover:underline"
          onClick={() => setCommandAllowlistTarget({ botId: bot.id, botName: bot.name })}
        >{t("commandAllowlist.manage")}</button>}
      </div>}

      {commandAllowlistTarget && <CommandAllowlistDialog
        key={`command-allowlist:${commandAllowlistTarget.botId}`}
        {...commandAllowlistTarget}
        onClose={() => setCommandAllowlistTarget(null)}
      />}
      {!draft && shows("outbound") && <OutboundControl bot={bot} fullAccess={approvalMode === "full"} onChange={(outbound) => patch({ outbound })} />}
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
    </div>
  );
}

function OutboundControl({ bot, fullAccess, onChange }: { bot: Bot; fullAccess: boolean; onChange: (policy: OutboundPolicy) => void }) {
  const policy = effectiveOutboundPolicy(bot.outbound, fullAccess);

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("permissions.outbound.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {t("permissions.outbound.help")}
      </div>
      <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
        {(
          [
            ["ask", t("permissions.outbound.ask"), t("permissions.outbound.askHint")],
            ["allow", t("permissions.outbound.allow"), t("permissions.outbound.allowHint")],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            key={value}
            title={hint}
            type="button"
            aria-pressed={policy.policy === value}
            onClick={() => {
              if (value !== bot.outbound?.policy) onChange({ policy: value });
            }}
            className={cn(
              "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium",
              policy.policy === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
