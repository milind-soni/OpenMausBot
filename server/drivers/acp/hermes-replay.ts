// Hermes can stream its reasoning again as one quoted "💭" block that ends with the reply already streamed.

/** True when `chunk` replays the reasoning before `streamed`, the reply text so far. */
export function isHermesReasoningReplay(chunk: string, streamed: string): boolean {
  const reply = streamed.trim();
  const replay = chunk.trim();
  return reply !== "" && /^(?:> |-# )?💭/.test(replay) && replay.endsWith(reply)
    && /\n\n[ \t]*$/.test(replay.slice(0, -reply.length));
}
