export interface TeamMapBot {
  id: string;
  name: string;
  hidden?: boolean;
  section?: string;
  chiefOfStaff?: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
}

export interface TeamMapSnapshot {
  collaborations: Array<{ groupId: string; botIds: [string, string]; lastAt: number }>;
  queued: Array<{ sourceBotId: string; targetBotId: string; reason?: string }>;
  running: Array<{ sourceBotId: string; targetBotId: string; threadId: string; groupId?: string }>;
}

export interface TeamMapSection<T extends TeamMapBot = TeamMapBot> {
  /** Exact persisted section identity; empty string is the unsectioned team. */
  key: string;
  name: string;
  chiefs: T[];
  members: T[];
}

export type TeamMapEdge = {
  sourceBotId: string;
  targetBotId: string;
  state: "running" | "queued" | "connected";
  reason?: string;
  groupId?: string;
  lastAt?: number;
};

export interface TeamMapStatus {
  label: string;
  tone: "success" | "warning" | "danger" | "idle";
}

export const EMPTY_TEAM_MAP_SNAPSHOT: TeamMapSnapshot = {
  collaborations: [],
  queued: [],
  running: [],
};

export function buildTeamMapSections<T extends TeamMapBot>(bots: T[]): TeamMapSection<T>[] {
  const sections = new Map<string, T[]>();
  for (const bot of bots) {
    if (bot.hidden) continue;
    const key = bot.section?.trim() || "";
    sections.set(key, [...(sections.get(key) ?? []), bot]);
  }
  return [...sections].map(([key, sectionBots]) => ({
    key,
    name: key || "General",
    chiefs: sectionBots.filter((bot) => bot.chiefOfStaff),
    members: sectionBots.filter((bot) => !bot.chiefOfStaff),
  }));
}

/** One visible edge per pair. A running handoff outranks a queued one,
 * which outranks the durable connection left by an earlier conversation. */
export function buildTeamMapEdges(bots: TeamMapBot[], snapshot: TeamMapSnapshot): TeamMapEdge[] {
  const visible = new Set(bots.filter((bot) => !bot.hidden).map((bot) => bot.id));
  const edges = new Map<string, TeamMapEdge>();
  const key = (sourceBotId: string, targetBotId: string) => [sourceBotId, targetBotId].sort().join(":");
  for (const collaboration of snapshot.collaborations) {
    const [sourceBotId, targetBotId] = collaboration.botIds;
    if (!visible.has(sourceBotId) || !visible.has(targetBotId)) continue;
    edges.set(key(sourceBotId, targetBotId), {
      sourceBotId,
      targetBotId,
      state: "connected",
      groupId: collaboration.groupId,
      lastAt: collaboration.lastAt,
    });
  }
  for (const delegation of snapshot.queued) {
    if (!visible.has(delegation.sourceBotId) || !visible.has(delegation.targetBotId)) continue;
    edges.set(key(delegation.sourceBotId, delegation.targetBotId), {
      sourceBotId: delegation.sourceBotId,
      targetBotId: delegation.targetBotId,
      state: "queued",
      reason: delegation.reason,
    });
  }
  for (const delegation of snapshot.running) {
    if (!visible.has(delegation.sourceBotId) || !visible.has(delegation.targetBotId)) continue;
    edges.set(key(delegation.sourceBotId, delegation.targetBotId), {
      sourceBotId: delegation.sourceBotId,
      targetBotId: delegation.targetBotId,
      state: "running",
      groupId: delegation.groupId,
    });
  }
  return [...edges.values()].sort((a, b) => {
    const priority = { running: 0, queued: 1, connected: 2 } as const;
    return priority[a.state] - priority[b.state] || (b.lastAt ?? 0) - (a.lastAt ?? 0);
  });
}

export function teamMapStatus(bot: TeamMapBot): TeamMapStatus {
  if (bot.activity === "waiting-on-you") return { label: "Waiting for you", tone: "warning" };
  if (bot.activity === "dead" || bot.activity === "no-signal") return { label: "No signal", tone: "danger" };
  if (bot.busy || bot.activity === "working") return { label: "Working", tone: "success" };
  return { label: "Ready", tone: "idle" };
}
