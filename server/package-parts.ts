// Release (r) and written (w) hashes per part. The value shapes are frozen: change nothing here without a new stamp version.
import { createHash } from "node:crypto";

import { canonicalJson, decodeBase64 } from "../shared/package-format.ts";
import { DEFAULT_MASCOT_BODY } from "../shared/mascot-bodies.ts";
import type { MascotSelection } from "../shared/mascot-profile.ts";
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

export function partHash(value: unknown): string {
  return sha256Hex(canonicalJson(value ?? null));
}

export const pair = (release: unknown, written: unknown): PartPair => ({ r: partHash(release), w: partHash(written) });

export interface LookValue {
  color: string;
  mascotExpression: string | null;
  mascotBody: string | null;
  mascotProfile?: string;
  avatar: string | null;
  crop: string | null;
}

type MascotProfileLook = { selected: MascotSelection; shapes: ReadonlyArray<unknown> };
type LookAppearance = Omit<PackageAgent["appearance"], "mascotProfile"> & { mascotProfile?: MascotProfileLook };

export function mascotLookFields(appearance: {
  mascotBody?: string | null;
  mascotProfile?: MascotProfileLook;
}): Pick<LookValue, "mascotBody"> & Partial<Pick<LookValue, "mascotProfile">> {
  const selection = appearance.mascotProfile?.selected;
  const selectedBody = selection
    ? selection.kind === "builtin" ? selection.bodyId : DEFAULT_MASCOT_BODY
    : appearance.mascotBody;
  return {
    mascotBody: selectedBody ?? null,
    ...(appearance.mascotProfile?.shapes.length
      ? { mascotProfile: partHash(appearance.mascotProfile) }
      : {}),
  };
}

export function releaseLook(appearance: LookAppearance): LookValue {
  const bytes = appearance.avatar ? decodeBase64(appearance.avatar.data) : null;
  return {
    color: appearance.color,
    mascotExpression: appearance.mascotExpression ?? null,
    ...mascotLookFields(appearance),
    avatar: bytes ? sha256Hex(bytes) : null,
    crop: appearance.avatar?.crop ?? null,
  };
}

export function playbookValues(playbooks: ReadonlyArray<Pick<PackagePlaybook, "key" | "name" | "summary" | "triggers" | "instructions">>) {
  return playbooks.map(({ key, name, summary, triggers, instructions }) => ({ key, name, summary, triggers: [...triggers], instructions }));
}

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
    : room.defaultResponder.kind === "auto" && room.defaultResponder.agent
      ? { kind: "auto", agent: room.defaultResponder.agent }
      : { kind: room.defaultResponder.kind },
});

/** Run on startup appears only when set, so installs from before it keep their hash. */
export function scheduleValue(routine: {
  runOn: string;
  schedule: unknown;
  durationMinutes: number;
  timeoutMinutes?: number | null;
  overlap?: string | null;
  continuity?: boolean | null;
  runOnStartup?: boolean | null;
}) {
  return {
    runOn: routine.runOn,
    schedule: routine.schedule,
    durationMinutes: routine.durationMinutes,
    timeoutMinutes: routine.timeoutMinutes ?? null,
    overlap: routine.overlap ?? "skip",
    continuity: routine.continuity === true,
    ...(routine.runOnStartup === true ? { runOnStartup: true } : {}),
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
