import type { Message } from "@/state/store";

/** Whether an activity chip renders in a transcript. Plain tool runs stay
 * out unless the person turned Settings → Tool calls on; a bot⇄bot comm
 * chip stays because it links to another conversation; and a chip that
 * reports a failure (`ok: false`) always shows — a notice nobody can see
 * is not a notice. Rooms already apply this rule; 1:1 threads share it. */
export function activityChipVisible(message: Pick<Message, "tool" | "comm">, showToolCalls: boolean): boolean {
  return showToolCalls || Boolean(message.comm) || message.tool?.ok === false;
}
