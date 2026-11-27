// The live call line as the server reports it (GET /api/live/call and the stream's frames), and the order of the app's
// lookups of it (both re-exported by store.tsx).
import type { LiveCallState } from "../../shared/wire";

/** A missing `call` key is malformed, never "the line is free". */
export function liveCallFromFrame(frame: unknown): { call: LiveCallState | null } | null {
  if (!frame || typeof frame !== "object" || !Object.prototype.hasOwnProperty.call(frame, "call")) return null;
  const call: unknown = Reflect.get(frame, "call");
  if (call === null) return { call: null };
  if (!call || typeof call !== "object") return null;
  const record = call as Record<string, unknown>;
  if (typeof record.callId !== "string" || typeof record.botId !== "string" || typeof record.threadId !== "string" || typeof record.status !== "string") {
    return null;
  }
  return { call: call as LiveCallState };
}

let liveCallLookups = 0;
export function nextLiveCallLookup(): number {
  liveCallLookups += 1;
  return liveCallLookups;
}
