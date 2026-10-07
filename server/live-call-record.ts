// How a Live call is recorded in its chat (docs/superpowers/specs/
// 2026-09-25-live-call-bar-design.md, "The call id and the call row"):
// every request spoken on a call carries the call's id, and a call that
// went live leaves one "call" row when it ends. Neither ever holds anything
// said on the call beyond the requests the bot already received.

/** The Live-call fields a user line is stored with: `via: "call"` when it
 * was spoken on a call, and that call's id only alongside it. A typed, API
 * or relayed line never carries a call id, even one handed in by mistake. */
export function spokenLineFields(
  via: "api" | "call" | undefined,
  callId: string | undefined,
): { via?: "call"; callId?: string } {
  if (via !== "call") return {};
  return callId ? { via, callId } : { via };
}
