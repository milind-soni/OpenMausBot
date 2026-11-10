import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import type { TeamPerson } from "@/state/team-people";

/** A person's own welcome to a team (server/team-welcome.ts), from GET /api/me. */
export interface TeamWelcomeRecord { invitedBy: string | null; welcomedAt: number | null; hints: string[] }

export function parseTeamWelcome(value: unknown): TeamWelcomeRecord | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!record) return null;
  const invitedBy = typeof record.invitedBy === "string" && record.invitedBy.includes("@") ? record.invitedBy : null;
  const welcomedAt = typeof record.welcomedAt === "number" && record.welcomedAt > 0 ? record.welcomedAt : null;
  const hints = Array.isArray(record.hints) ? record.hints.filter((hint): hint is string => typeof hint === "string") : [];
  return { invitedBy, welcomedAt, hints };
}

/** Per team: undefined while it is read, null where the server keeps none (an older Team Cloud, or no team). */
let kept: { teamId: string; record: TeamWelcomeRecord | null | undefined } | null = null;
const listeners = new Set<() => void>();
const publish = (next: typeof kept) => { kept = next; for (const listener of listeners) listener(); };
const asked = new Set<string>();

function ask(teamId: string) {
  if (asked.has(teamId)) return;
  asked.add(teamId);
  void api<{ welcome?: unknown }>("/api/me", { timeoutMs: 10_000, background: true })
    .then((me) => publish({ teamId, record: parseTeamWelcome(me.welcome) }))
    .catch(() => publish({ teamId, record: null }));
}

/** This person's welcome on the team on screen; undefined until read, null off a team or on a Team Cloud too old to keep one. */
export function useTeamWelcomeRecord(teamId: string | null): TeamWelcomeRecord | null | undefined {
  useEffect(() => { if (teamId) ask(teamId); }, [teamId]);
  const current = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => kept, () => kept);
  if (!teamId) return null;
  return current?.teamId === teamId ? current.record : undefined;
}

/** They saw it: kept on the server for them alone, and gone from this screen at once (even when the save fails: it comes
 * back on another device, never twice here). */
export async function finishTeamWelcome(teamId: string): Promise<void> {
  const record = kept?.teamId === teamId ? kept.record : null;
  publish({ teamId, record: { invitedBy: record?.invitedBy ?? null, hints: record?.hints ?? [], welcomedAt: Date.now() } });
  await api("/api/me/welcome", { method: "PUT", body: JSON.stringify({ welcomed: true }), timeoutMs: 10_000 }).catch(() => {});
}

/** Only for tests: the record is module state. */
export function resetTeamWelcome(): void { asked.clear(); publish(null); }

/** A User's first time in the team: they have a record and haven't seen it. An Admin has the Cloud's own welcome. */
export function teamWelcomeDue(input: { team: { id: string } | null | undefined; canSave: boolean | undefined; record: TeamWelcomeRecord | null | undefined }): boolean {
  return Boolean(input.team) && input.canSave === false && Boolean(input.record) && input.record!.welcomedAt === null;
}

interface WelcomeBot { id: string; name: string; title?: string; description?: string; hidden?: boolean; defaultBot?: { person?: string } | null; yourAccess?: string }
export const WELCOME_PEOPLE = 6, WELCOME_BOTS = 4;

/**
 * What the welcome shows: who invited them (from the people list, else their address), everyone else in the team (a few,
 * and how many more), and the bots shared with them, each with one line; the first one they can chat with is the one
 * action. Their own MausBot is theirs, not shared, and a bot they can only view can't be the first chat.
 */
export function teamWelcomeView(input: { invitedBy: string | null; people: readonly TeamPerson[]; bots: readonly WelcomeBot[] }) {
  const inviter = input.invitedBy ? input.people.find((person) => person.email === input.invitedBy) ?? { email: input.invitedBy, name: "", role: "member" } : null;
  const others = input.people.filter((person) => !person.you);
  const shared = input.bots.filter((bot) => !bot.hidden && !bot.defaultBot?.person);
  const line = (bot: WelcomeBot) => (bot.description?.trim() || bot.title?.trim() || "").split("\n")[0]!.slice(0, 140);
  return {
    inviter,
    people: others.slice(0, WELCOME_PEOPLE), morePeople: Math.max(0, others.length - WELCOME_PEOPLE),
    bots: shared.slice(0, WELCOME_BOTS).map((bot) => ({ id: bot.id, name: bot.name, line: line(bot) })), moreBots: Math.max(0, shared.length - WELCOME_BOTS),
    first: shared.find((bot) => bot.yourAccess !== "view") ?? null,
  };
}
