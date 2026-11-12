import type { ResolvedSender } from "../../shared/wire.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import type { DataContext } from "../data-context.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import { createQuotaSwitch, type QuotaRequest, type QuotaSwitchDeps } from "../quota-switch.ts";
import type { BotRecord, Message } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { resolveYourComputerAsk } from "../your-computer-consent.ts";

export interface QuotaSwitchHostDeps extends Pick<QuotaSwitchDeps, "store" | "coordinator" | "turnStops" | "takeover"> {
  registry: Pick<ProviderRegistry, "instances" | "access">;
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  providerConfigs(): InstanceConfigMap;
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  checkedTaskModelSwitch(
    current: BotRecord, raw: unknown, updateBotDefault: boolean, resetApprovalToAsk: boolean, requireAvailableModel?: boolean,
  ): ReturnType<QuotaSwitchDeps["gate"]>;
  threadBusy(botId: string, threadId: string): boolean;
  directRequestOwners: { get(threadId: string): QuotaRequest | undefined };
  sessionLive(sessionId: string): boolean;
  /** Other cards the harness raises and settles itself: true when it was one. */
  ownCards?(requestId: string, behavior: "allow" | "deny" | "answer"): boolean;
  startOrQueueDirectMessage(
    botId: string, threadId: string, text: string, replyTo?: Message, sendId?: string, sender?: ResolvedSender,
    trigger?: UsageTrigger, via?: "call", callId?: string, dataContext?: DataContext,
    app?: { context?: string; fromApp?: Message["fromApp"]; pointed?: Message["pointed"] }, mentions?: string[], requestSessionId?: string,
  ): Promise<unknown>;
}

export function createQuotaSwitchHost(deps: QuotaSwitchHostDeps) {
  const {
    store, coordinator, registry, turnStops, hostedModels, providerConfigs, policyModelRefusal,
    checkedTaskModelSwitch, threadBusy, directRequestOwners, startOrQueueDirectMessage, takeover,
  } = deps;

  const quotaSwitch = createQuotaSwitch({
    store, coordinator, registry, turnStops, takeover,
    access: instanceId => providerConfigs()[instanceId]?.access ?? registry.access(instanceId),
    refusal: policyModelRefusal,
    gate: (thread, selection) => checkedTaskModelSwitch(thread, selection, false, false, true),
    reset: (from, to) => hostedModels?.resetTask(from, to),
    busy: threadBusy,
    request: threadId => directRequestOwners.get(threadId), sessionLive: deps.sessionLive,
    resend: (botId, threadId, message, replyTo, spoken, requestSessionId) => startOrQueueDirectMessage(botId, threadId, message.text ?? "", replyTo, undefined, message.sender, undefined, spoken.via, spoken.callId, message.dataContext, undefined, undefined, requestSessionId),
  });

  /** Settles a card the harness raised itself (a use-your-computer ask or a quota-switch offer); undefined for any other card. */
  async function harnessCardOutcome(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown): Promise<string | undefined> {
    if (!store.messagesFor(threadId).some(candidate => candidate.card?.requestId === requestId)) return undefined;
    if (resolveYourComputerAsk(requestId, behavior) || deps.ownCards?.(requestId, behavior)) return behavior === "allow" ? "allowed-once" : "rejected";
    return await quotaSwitch.answer(threadId, requestId, behavior, message) ?? undefined;
  }

  return { quotaSwitch, harnessCardOutcome };
}
