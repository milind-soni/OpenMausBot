import { replyAddress, SUPPORT_LIMITS, type SupportTopic } from "../../electron/support-request.mjs";
import type { CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { api } from "@/state/store";

export const SUPPORT_DIAGNOSTICS_PATH = "/api/support/diagnostics";

/** Contact support for the account signed in here: offered only while the Admin says it may write (a paid Cloud or Team
 * plan, its own or its team's) and main can send it; null otherwise, so nothing changes for anyone else. */
export function supportOffer(plan: CloudPlanSnapshot | null, bridge: { support?: unknown } | undefined): NonNullable<CloudPlanSnapshot["support"]> | null {
  return plan?.support && typeof bridge?.support === "function" ? plan.support : null;
}

export interface SupportForm { topic: SupportTopic | ""; message: string; replyTo: string }
/** Which required fields still need the person: each a sentence the form shows under its field. */
export function supportProblems(form: SupportForm): { topic: boolean; message: boolean; replyTo: boolean } {
  return { topic: !form.topic, message: !form.message.trim() || form.message.length > SUPPORT_LIMITS.message, replyTo: replyAddress(form.replyTo) === null };
}

/** What "Include diagnostics" adds, from this page's server; null when it can't say (a Team Cloud's member, offline). */
export async function readSupportDiagnostics(): Promise<string | null> {
  try {
    const { text } = await api<{ text?: unknown }>(SUPPORT_DIAGNOSTICS_PATH);
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}
