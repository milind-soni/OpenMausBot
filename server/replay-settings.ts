import { z } from "zod";

export const replaySettings = {
  /** Bytes of history a rebuilt session is replayed. */
  rebuildBytes: z.number().int().min(1_024).max(1_000_000).optional(),
  /** Also tell a session rebuilt from an inline replay which tools already ran, one line per call. Off unless true; OMB_REPLAY_TOOL_HISTORY=1 or 0 overrides. */
  replayToolHistory: z.boolean().optional(),
};

export function replayToolHistoryEnabled(
  settings: { replayToolHistory?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = env.OMB_REPLAY_TOOL_HISTORY?.trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return settings?.replayToolHistory === true;
}
