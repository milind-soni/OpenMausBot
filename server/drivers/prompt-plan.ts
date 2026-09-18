import { appendNative } from "./native.ts";

export type NativePromptPlanMode = "fresh" | "resume" | "recovery" | "rotate";

export type NativePromptPlan = {
  mode: NativePromptPlanMode;
  owner: "direct" | "room";
  botId: string;
  providerInstanceId: string;
  systemBuiltBytes: number;
  systemSentBytes: number;
  turnTextBytes: number;
  recoveryTextBytes: number;
  sections: Array<{ id: string; bytes: number; sent: boolean }>;
  roomMessagesSent?: number;
  roomMessagesRetained?: number;
  reason: string;
};

function validByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCount(value: number | undefined): boolean {
  return value === undefined || validByteCount(value);
}

/**
 * Append one provider-native prompt receipt after validating the measured
 * facts supplied by an instrumented driver. This writer never sees prompt
 * text and never derives byte counts or section membership.
 */
export function appendPromptPlan(threadId: string, plan: NativePromptPlan): void {
  if (!threadId || !plan.botId || !plan.providerInstanceId || !plan.reason) return;
  if (!validByteCount(plan.systemBuiltBytes) || !validByteCount(plan.systemSentBytes) ||
      !validByteCount(plan.turnTextBytes) || !validByteCount(plan.recoveryTextBytes) ||
      !validCount(plan.roomMessagesSent) || !validCount(plan.roomMessagesRetained)) return;
  const ids = new Set<string>();
  if (plan.sections.some((section) => {
    if (!section.id || ids.has(section.id) || !validByteCount(section.bytes) || typeof section.sent !== "boolean") return true;
    ids.add(section.id);
    return false;
  })) return;
  appendNative(threadId, { dir: "out", source: "prompt.plan", msg: plan });
}
