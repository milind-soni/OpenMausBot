// propose_team_memory's arguments, checked and shaped for /api/internal/team-memory.
import type { Json } from "./agents-client.ts";

export const TEAM_MEMORY_TOOL = "propose_team_memory";

const FORGET_EXAMPLE = '{"action":"forget","kind":"term","name":"OKR","detail":"Saved in the wrong team."}';
const FORGET_WORDS = new Set(["forget", "remove", "delete"]);

function teamMemoryAction(value: unknown): "save" | "forget" | null {
  const action = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!action || action === "save") return "save";
  return FORGET_WORDS.has(action) ? "forget" : null;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The body to send and what the result names, or the error that teaches the call. */
export function teamMemoryRequest(args: Json, botId: string, threadId: string): { body: Json; subject: string } | { error: string } {
  const action = teamMemoryAction(args.action);
  if (!action) return { error: `propose_team_memory action is save or forget, for example ${FORGET_EXAMPLE}.` };
  const kind = text(args.kind);
  const name = text(args.name);
  const detail = text(args.detail);
  if (action === "forget") {
    const key = text(args.key);
    if (!key && (!kind || !name)) {
      return { error: `propose_team_memory action=forget needs the entry's key, or its kind and name (session_search scope=team shows them), for example ${FORGET_EXAMPLE}.` };
    }
    return {
      body: { fromBotId: botId, fromThreadId: threadId, action, ...(kind ? { kind } : {}), ...(key ? { key } : {}), ...(name ? { name } : {}), ...(detail ? { detail } : {}) },
      subject: `the removal of the team memory entry for ${name || key}`,
    };
  }
  if (!kind || !name || !detail) return { error: "propose_team_memory needs kind, name, and detail." };
  return {
    body: {
      fromBotId: botId,
      fromThreadId: threadId,
      kind,
      key: typeof args.key === "string" ? args.key : undefined,
      name,
      detail,
      aliases: Array.isArray(args.aliases) ? args.aliases.filter((alias) => typeof alias === "string") : undefined,
    },
    subject: `the team memory entry for ${name}`,
  };
}
