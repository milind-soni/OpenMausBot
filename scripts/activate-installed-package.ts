import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseBotPackage } from "../server/bot-package.ts";
import { DATA_DIR } from "../server/config.ts";
import { RoutineManager } from "../server/routines.ts";
import { Store } from "../server/store.ts";

const packagePath = resolve(process.argv[2] ?? "packages/grok-capture.openmaus.json");
const dryRun = process.argv.includes("--dry-run");
const document = parseBotPackage(JSON.parse(readFileSync(packagePath, "utf8")));
const pkg = document.package;
const store = new Store(() => ({ instanceId: "", model: "" }));
const routines = new RoutineManager({
  botState: (botId) => (store.bot(botId) ? "ready" : "missing"),
  createTask: () => null,
  startTurn: async () => undefined,
});

const installedBots = new Map<string, ReturnType<Store["bot"]>>();
for (const agent of pkg.agents) {
  const matches = store.bots.filter(
    (bot) => bot.name === agent.name && bot.installedPackage?.id === pkg.id,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one installed ${agent.name} bot, found ${matches.length}`);
  }
  installedBots.set(agent.key, matches[0]);
}

const routineUpdates = (pkg.routines ?? []).map((definition) => {
  const bot = installedBots.get(definition.agent);
  if (!bot) throw new Error(`No installed bot for package agent ${definition.agent}`);
  const matches = routines.listRoutines().filter(
    (routine) => routine.name === definition.name && routine.botId === bot.id,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one live routine named ${definition.name}, found ${matches.length}`);
  }
  return { definition, current: matches[0], bot };
});

const playbookByKey = new Map((pkg.playbooks ?? []).map((playbook) => [playbook.key, playbook]));
const installedIds = new Set([...installedBots.values()].flatMap((bot) => bot ? [bot.id] : []));
const legacySectionNames = new Set(
  [...installedBots.values()].flatMap((bot) => {
    const oldName = bot?.installedPackage?.name;
    return oldName && oldName !== pkg.name && bot.section === oldName ? [oldName] : [];
  }),
);
const summary = {
  package: pkg.id,
  fromReleases: [...new Set([...installedBots.values()].map((bot) => bot?.installedPackage?.release))],
  toRelease: pkg.release,
  bots: pkg.agents.map((agent) => ({
    name: agent.name,
    playbooks: agent.playbooks ?? [],
  })),
  routines: routineUpdates.map(({ current }) => current.name),
  dryRun,
};

if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(DATA_DIR, "backups", `package-activation-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(join(DATA_DIR, "bots.json"), join(backupDir, "bots.json"));
  copyFileSync(join(DATA_DIR, "routines.json"), join(backupDir, "routines.json"));

  for (const agent of pkg.agents) {
    const bot = installedBots.get(agent.key);
    if (!bot) throw new Error(`No installed bot for package agent ${agent.key}`);
    const playbooks = (agent.playbooks ?? []).map((key) => {
      const playbook = playbookByKey.get(key);
      if (!playbook) throw new Error(`Missing package playbook ${key}`);
      return { ...playbook };
    });
    store.patchBot(bot.id, {
      playbooks,
      // Reporting is a user preference. Seed the package default only for
      // records created before the setting existed; never overwrite a choice
      // the user made in Agent profile.
      ...(bot.reportingMode === undefined && agent.reportingMode
        ? { reportingMode: agent.reportingMode }
        : {}),
      ...(bot.section && legacySectionNames.has(bot.section) ? { section: pkg.name } : {}),
      installedPackage: {
        id: pkg.id,
        name: pkg.name,
        release: pkg.release,
        requiredApps: pkg.requirements.apps.map((app) => ({ ...app })),
      },
    });
  }

  for (const room of store.groups) {
    if (
      room.section &&
      legacySectionNames.has(room.section) &&
      room.memberIds.length > 0 &&
      room.memberIds.every((id) => installedIds.has(id))
    ) {
      store.patchGroup(room.id, { section: pkg.name });
    }
  }

  for (const { definition, current, bot } of routineUpdates) {
    routines.update(current.id, {
      name: definition.name,
      prompt: definition.prompt,
      botId: bot.id,
      runOn: definition.runOn,
      enabled: current.enabled,
      schedule: definition.schedule,
      durationMinutes: definition.durationMinutes,
      // Send the explicit empty shape when a release removes a budget. The
      // routine API treats `{}` as "clear"; omitting the field preserves the
      // previous release's stale budget.
      budget: definition.budget ?? {},
      prefilter: definition.prefilter,
      capabilities: definition.capabilities ?? {},
      maxChangedStrategyRetries: definition.maxChangedStrategyRetries ?? 0,
    });
  }
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
