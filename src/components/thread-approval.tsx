import { useState, type ComponentProps, type ReactNode } from "react";

import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import { CommandAllowlistDialog } from "./CommandAllowlistDialog";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";

export type ApprovalChoice = ComponentProps<typeof ApprovalModeSelector>;

/** One conversation's approval level as every control offers it (the composer and the bot panel), with the dialogs a
 * choice can open: the warning before Auto on this computer, and the command allowlist. A remote client gets none. */
export function useThreadApproval(bot: Bot | undefined): { choice: ApprovalChoice | undefined; dialogs: ReactNode } {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const ownerOrAdmin = useOwnerOrAdmin();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const [warning, setWarning] = useState<{ botId: string; threadId: string } | null>(null);
  const [allowlist, setAllowlist] = useState<{ botId: string; botName: string; threadId: string } | null>(null);
  const engine = bot ? state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId) : undefined;
  const trusted = Boolean(!remoteClient && window.ogb?.approvals && capabilities.host.packaged);
  const onSelect = (mode: ApprovalMode) => {
    if (!bot || mode === approvalModeFor(bot)) return;
    if (mode === "custom" && !trusted) return;
    if (mode === "auto" && bot.computer === "local") {
      setWarning({ botId: bot.id, threadId: bot.threadId });
      return;
    }
    dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { approvalMode: mode } });
  };
  const choice: ApprovalChoice | undefined = bot && engine && !remoteClient ? {
    approvalMode: bot.approvalMode,
    autoApprove: bot.autoApprove,
    providerName: engine.displayName,
    driverKind: engine.driverKind,
    onSelect,
    busy: Boolean(bot.busy),
    trustedModesAvailable: trusted,
    onManageCommandAllowlist: ownerOrAdmin === true ? () => setAllowlist({ botId: bot.id, botName: bot.name, threadId: bot.threadId }) : undefined,
  } : undefined;
  const dialogs = (
    <>
      {allowlist && <CommandAllowlistDialog key={`${allowlist.botId}:${allowlist.threadId}`} {...allowlist} onClose={() => setAllowlist(null)} />}
      <LocalComputerAutoWarning
        open={warning !== null}
        onCancel={() => setWarning(null)}
        onConfirm={() => {
          if (warning) {
            dispatch({ type: "updateTask", botId: warning.botId, threadId: warning.threadId, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
          }
          setWarning(null);
        }}
      />
    </>
  );
  return { choice, dialogs };
}
