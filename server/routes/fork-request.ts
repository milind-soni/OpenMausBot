import { userError } from "../user-errors.ts";

export function parseForkRequest(body: unknown, allowBranch = false): { messageId?: string; branchLeafId?: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length === 1 && "messageId" in body && typeof body.messageId === "string") return { messageId: body.messageId };
  if (!("latest" in body) || body.latest !== true) return null;
  if (keys.length === 1) return {};
  if (allowBranch && keys.length === 2 && "branchLeafId" in body && typeof body.branchLeafId === "string" && body.branchLeafId) {
    return { branchLeafId: body.branchLeafId };
  }
  return null;
}

export const FORK_BUSY = userError("serverError.forkBusy");
export const FORK_NO_TEXT = userError("serverError.forkNoText");
