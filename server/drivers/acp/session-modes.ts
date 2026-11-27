import type { ApprovalMode } from "../../../shared/approval-mode.ts";

export interface AcpSessionMode {
  id: string;
  name?: string;
}

export interface AcpSessionModes {
  availableModes: AcpSessionMode[];
  currentModeId?: string;
}

const CANDIDATES: Record<ApprovalMode, readonly string[]> = {
  ask: ["default", "ask", "normal"],
  edits: ["accept_edits", "acceptedits", "accept-edits", "auto_edit", "auto-edit", "auto-accept"],
  auto: ["default", "ask", "normal"],
  // Full access keeps the agent's own default mode: every permission request still reaches OMB, which approves it
  // unless the safety floor holds it. A native don't-ask mode would run never-list commands without asking.
  full: ["default", "ask", "normal"],
  custom: ["default", "ask", "normal"],
};

/** Reads ACP `modes` advertised by `session/new` or `session/load`. Returns null when absent or empty. */
export function readSessionModes(result: unknown): AcpSessionModes | null {
  const raw = (result as { modes?: unknown } | null)?.modes;
  if (!raw || typeof raw !== "object") return null;
  const { availableModes: rawModes, currentModeId: rawCurrent } = raw as { availableModes?: unknown; currentModeId?: unknown };
  if (!Array.isArray(rawModes)) return null;
  const availableModes: AcpSessionMode[] = [];
  for (const entry of rawModes) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !id.trim()) continue;
    availableModes.push({
      id,
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    });
  }
  if (availableModes.length === 0) return null;
  const currentModeId = typeof rawCurrent === "string" && rawCurrent.trim() ? rawCurrent.trim() : undefined;
  return { availableModes, ...(currentModeId ? { currentModeId } : {}) };
}

/** Maps an OpenMausBot approval level onto an advertised ACP mode id without inventing unadvertised values. */
export function selectAdvertisedMode(
  available: readonly AcpSessionMode[],
  approvalMode: ApprovalMode | undefined,
  fullAuto: boolean,
): string | null {
  const level: ApprovalMode = approvalMode ?? (fullAuto ? "full" : "ask");
  const byLower = new Map<string, string>();
  for (const mode of available) {
    const key = mode.id.trim().toLowerCase();
    if (key && !byLower.has(key)) byLower.set(key, mode.id);
  }
  for (const candidate of CANDIDATES[level]) {
    const matched = byLower.get(candidate);
    if (matched !== undefined) return matched;
  }
  return null;
}

/** Records a newly confirmed or notified ACP `currentModeId` without discarding advertised `availableModes`. */
export function withSessionMode(result: any, modeId: unknown): any {
  if (typeof modeId !== "string" || !modeId.trim()) return result;
  return { ...result, modes: { ...result?.modes, currentModeId: modeId.trim() } };
}

/** Extracts `currentModeId` from an ACP `current_mode_update` notification, or null for any other update. */
export function currentModeUpdateId(update: unknown): string | null {
  if (!update || typeof update !== "object") return null;
  const { sessionUpdate, currentModeId } = update as { sessionUpdate?: unknown; currentModeId?: unknown };
  return sessionUpdate === "current_mode_update" && typeof currentModeId === "string" && currentModeId.trim()
    ? currentModeId.trim()
    : null;
}
