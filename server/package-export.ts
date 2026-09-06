import { parseBotPackage, type BotPackageDefinition, type BotPackagePlaybook, type ParsedBotPackage } from "./bot-package.ts";
import type { Routine } from "./routines.ts";
import type { BotRecord, GroupRecord, InstalledPlaybook } from "./store.ts";

function portableKey(value: string, fallback: string, used: Set<string>): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || fallback;
  let key = stem;
  for (let suffix = 2; used.has(key); suffix++) key = `${stem}-${suffix}`;
  used.add(key);
  return key;
}

function samePlaybook(a: InstalledPlaybook, b: BotPackagePlaybook): boolean {
  return a.name === b.name && a.summary === b.summary && a.instructions === b.instructions &&
    a.triggers.join("\n") === b.triggers.join("\n");
}

/** Export a workspace definition, never its runtime state. Connected-app
 * labels are retained as setup intent, but grants, credentials, approvals,
 * transcripts, memory, paths, engines, and schedules' active state are not. */
export function createBotPackageExport(input: {
  name: string;
  authorName?: string;
  bots: BotRecord[];
  groups: GroupRecord[];
  routines: Routine[];
}): ParsedBotPackage {
  const bots = input.bots.filter((bot) => !bot.hidden);
  if (!bots.length) throw new Error("Create a bot before exporting your package");

  const packageKeys = new Set<string>();
  const idToKey = new Map<string, string>();
  for (const [index, bot] of bots.entries()) {
    idToKey.set(bot.id, portableKey(bot.name, `bot-${index + 1}`, packageKeys));
  }

  const playbooks: BotPackagePlaybook[] = [];
  const playbookKeys = new Set<string>();
  const agentPlaybooks = new Map<string, string[]>();
  for (const bot of bots) {
    const agentKey = idToKey.get(bot.id)!;
    const assigned: string[] = [];
    for (const playbook of bot.playbooks ?? []) {
      const existing = playbooks.find((candidate) => candidate.key === playbook.key);
      if (existing && samePlaybook(playbook, existing)) {
        assigned.push(existing.key);
        continue;
      }
      let key = playbook.key;
      if (existing) key = `${agentKey}-${playbook.key}`;
      key = portableKey(key, `${agentKey}-playbook`, playbookKeys);
      if (!playbooks.some((candidate) => candidate.key === key)) playbooks.push({ ...playbook, key });
      assigned.push(key);
    }
    agentPlaybooks.set(bot.id, assigned);
  }

  const requirements = new Map<string, { slug: string; label: string; reason: string; optional?: boolean }>();
  for (const bot of bots) {
    for (const app of bot.installedPackage?.requiredApps ?? []) {
      if (!requirements.has(app.slug)) requirements.set(app.slug, { ...app });
    }
  }

  const roomKeys = new Set<string>();
  const rooms: NonNullable<BotPackageDefinition["rooms"]> = [];
  for (const [index, group] of input.groups.filter((group) => !group.dm).entries()) {
    const members = group.memberIds.flatMap((id) => idToKey.has(id) ? [idToKey.get(id)!] : []);
    if (!members.length) continue;
    const defaultResponder = group.defaultResponder.kind === "member" && idToKey.has(group.defaultResponder.botId)
      ? { kind: "agent" as const, agent: idToKey.get(group.defaultResponder.botId)! }
      : group.defaultResponder.kind === "everyone"
        ? { kind: "everyone" as const }
        : { kind: "mentions" as const };
    rooms.push({
      key: portableKey(group.name, `room-${index + 1}`, roomKeys),
      name: group.name,
      members,
      bulletin: group.bulletin,
      defaultResponder,
    });
  }

  const routineKeys = new Set<string>();
  const routines: NonNullable<BotPackageDefinition["routines"]> = input.routines.flatMap((routine, index) => {
    // Package v1 only has a single-agent routine shape. Silently exporting a
    // room goal as a bot task would change what it does after import, so keep
    // it out until the portable format can name a package-local room.
    if (routine.target === "room-goal") return [];
    const agent = idToKey.get(routine.botId);
    if (!agent) return [];
    return [{
      key: portableKey(routine.name, `routine-${index + 1}`, routineKeys),
      name: routine.name,
      agent,
      prompt: routine.prompt,
      runOn: routine.runOn,
      schedule: routine.schedule.type === "once"
        ? { type: "once", at: routine.schedule.at }
        : routine.schedule.type === "interval"
          ? {
              type: "interval",
              everyMinutes: routine.schedule.everyMinutes,
              anchorAt: routine.schedule.anchorAt,
            }
          : { type: "daily", time: routine.schedule.time, weekdays: [...routine.schedule.weekdays] },
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      enabledAfterInstall: false as const,
    }];
  });

  const id = portableKey(input.name, "openmaus-package", new Set());
  const agents: BotPackageDefinition["agents"] = bots.map((bot) => {
    const appearance: BotPackageDefinition["agents"][number]["appearance"] = { color: bot.color };
    if (bot.mascotExpression) appearance.mascotExpression = bot.mascotExpression;
    if (bot.mascotBody) appearance.mascotBody = bot.mascotBody;
    const agent: BotPackageDefinition["agents"][number] = {
      key: idToKey.get(bot.id)!,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      ...(bot.soul !== undefined ? { soul: bot.soul } : {}),
      appearance,
    };
    const assigned = agentPlaybooks.get(bot.id);
    if (assigned?.length) agent.playbooks = assigned;
    return agent;
  });
  const definition: BotPackageDefinition = {
    id,
    release: "1.0.0",
    name: input.name,
    tagline: `A portable OpenMausBot setup with ${bots.length} ${bots.length === 1 ? "bot" : "bots"}.`,
    summary: "Exported from OpenMausBot. Review the roles, rooms, playbooks, connector requirements, and paused routines before sharing or publishing.",
    category: "Community",
    author: { name: input.authorName?.trim() || "OpenMausBot user" },
    license: "Unspecified",
    outcomes: ["Recreate this bot setup without copying private runtime state."],
    setupMinutes: Math.min(240, Math.max(2, bots.length + requirements.size * 2)),
    requirements: { apps: [...requirements.values()], capabilities: [] },
    agents,
  };
  const chief = bots.find((bot) => bot.chiefOfStaff);
  if (chief) definition.chiefOfStaff = idToKey.get(chief.id)!;
  if (rooms.length) definition.rooms = rooms;
  if (routines.length) definition.routines = routines;
  if (playbooks.length) definition.playbooks = playbooks;
  return parseBotPackage({
    format: "openmaus.package",
    version: 1,
    package: definition,
  });
}
