// Part hashes for records added from an organization's library (contract
// §1.6). Every part of an added team keeps two hashes: `r`, the value the
// release shipped, and `w`, the value OpenMausBot wrote at install. The
// automatic updater compares them later: `hash(local) ≠ w` means the person
// edited the part, `r(new release) ≠ r` means the publisher changed it. Only
// the hashes are kept, never a second copy of the content.
//
// The value shapes are frozen: a stamp written today must still compare
// correctly in a later version, so change nothing here without a new stamp
// version.
import { createHash } from "node:crypto";

import { canonicalJson, decodeBase64 } from "../shared/package-format.ts";
import type {
  PackageAgent,
  PackageConnection,
  PackagePlaybook,
  PackageRoom,
  PackageRoutine,
} from "../shared/package-format.ts";

export interface PartPair { r: string; w: string }

export const AGENT_PARTS = ["name", "title", "description", "soul", "look", "playbooks", "skills", "connections", "approval"] as const;
export type AgentPart = typeof AGENT_PARTS[number];
export const ROOM_PARTS = ["name", "bulletin", "members", "defaultResponder"] as const;
export type RoomPart = typeof ROOM_PARTS[number];
export const ROUTINE_PARTS = ["name", "prompt", "schedule", "target"] as const;
export type RoutinePart = typeof ROUTINE_PARTS[number];
export const TEAM_PARTS = ["name", "brief", "leader"] as const;
export type TeamPart = typeof TEAM_PARTS[number];

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** sha256hex(utf8(canonicalJson(value ?? null))) */
export function partHash(value: unknown): string {
  return sha256Hex(canonicalJson(value ?? null));
}

export const pair = (release: unknown, written: unknown): PartPair => ({ r: partHash(release), w: partHash(written) });

/** A bot's look: colour, mascot, and the picture by its bytes' hash. */
export interface LookValue {
  color: string;
  mascotExpression: string | null;
  mascotBody: string | null;
  avatar: string | null;
  crop: string | null;
}

export function releaseLook(appearance: PackageAgent["appearance"]): LookValue {
  const bytes = appearance.avatar ? decodeBase64(appearance.avatar.data) : null;
  return {
    color: appearance.color,
    mascotExpression: appearance.mascotExpression ?? null,
    mascotBody: appearance.mascotBody ?? null,
    avatar: bytes ? sha256Hex(bytes) : null,
    crop: appearance.avatar?.crop ?? null,
  };
}

export function playbookValues(playbooks: ReadonlyArray<Pick<PackagePlaybook, "key" | "name" | "summary" | "triggers" | "instructions">>) {
  return playbooks.map(({ key, name, summary, triggers, instructions }) => ({ key, name, summary, triggers: [...triggers], instructions }));
}

/** The release side of every bot part. */
export function agentReleaseValues(agent: PackageAgent, playbooks: ReadonlyMap<string, PackagePlaybook>): Record<AgentPart, unknown> {
  return {
    name: agent.name,
    title: agent.title ?? "",
    description: agent.description ?? "",
    soul: agent.soul ?? "",
    look: releaseLook(agent.appearance),
    playbooks: playbookValues((agent.playbooks ?? []).flatMap((key) => (playbooks.has(key) ? [playbooks.get(key)!] : []))),
    skills: [...(agent.skills ?? [])].sort(),
    connections: [...(agent.connections ?? [])].sort(),
    approval: agent.approval ?? null,
  };
}

export const roomReleaseValues = (room: PackageRoom): Record<RoomPart, unknown> => ({
  name: room.name,
  bulletin: room.bulletin ?? "",
  members: [...room.members].sort(),
  defaultResponder: room.defaultResponder.kind === "agent"
    ? { kind: "agent", agent: room.defaultResponder.agent }
    : { kind: room.defaultResponder.kind },
});

/** One normal form for a routine's timing on both sides, so an untouched
 * routine compares equal: absent cap → null, absent overlap → "skip". */
export function scheduleValue(routine: {
  runOn: string;
  schedule: unknown;
  durationMinutes: number;
  timeoutMinutes?: number | null;
  overlap?: string | null;
  continuity?: boolean | null;
}) {
  return {
    runOn: routine.runOn,
    schedule: routine.schedule,
    durationMinutes: routine.durationMinutes,
    timeoutMinutes: routine.timeoutMinutes ?? null,
    overlap: routine.overlap ?? "skip",
    continuity: routine.continuity === true,
  };
}

export const routineReleaseValues = (routine: PackageRoutine): Record<RoutinePart, unknown> => ({
  name: routine.name,
  prompt: routine.prompt,
  schedule: scheduleValue(routine),
  target: { agent: routine.agent, room: routine.room ?? null },
});

export const connectionReleaseValue = (connection: PackageConnection) => ({
  transport: connection.mcp.transport,
  url: connection.mcp.url,
  valueNames: [...connection.mcp.valueNames],
});

export function connectionLocalValue(server: { type?: unknown; url?: unknown; headers?: unknown }) {
  const headers = server.headers && typeof server.headers === "object" ? Object.keys(server.headers as object) : [];
  return { transport: server.type ?? null, url: server.url ?? null, valueNames: headers.sort() };
}

export function pairs<K extends string>(keys: readonly K[], release: Record<K, unknown>, written: Record<K, unknown>): Record<K, PartPair> {
  return Object.fromEntries(keys.map((key) => [key, pair(release[key], written[key])])) as Record<K, PartPair>;
}
