// Real scheduler, routes, MCP proposal and renderer, only in a disposable home.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
import { waitForExit } from "../server/testing/cleanup.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
const evidence: unknown[] = [];
const api = fixtureApi(fixture.info.url, {
  headers: { origin: fixture.info.url },
  observe: (call) => { if (call.method !== "GET") evidence.push(call); },
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Fixture timed out; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  await control(["doctor"]);
  await control(["new-bot", "--name", "Pepper"]);
  await control(["new-bot", "--name", "Miso"]);
  const { bots } = await api("GET", "/api/bots");
  const pepper = bots.find((bot: { name: string }) => bot.name === "Pepper");
  const miso = bots.find((bot: { name: string }) => bot.name === "Miso");
  await api("PUT", "/api/config", { profile: { name: "Routines verification" } });
  const gate = join(fixture.info.dataDir, "proposal-finished");
  const wrapper = join(fixture.info.dataDir, "routine-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { existsSync, readFileSync } from "node:fs";',
    'const at = process.argv.indexOf("--mcp-config");',
    'const bot = at < 0 ? null : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_BOT_ID;',
    `process.env.FAKE_CLAUDE_MODE = bot === ${JSON.stringify(miso.id)} ? "exit-early" : existsSync(${JSON.stringify(gate)}) ? "happy" : "slow";`,
    `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  await control(["send", "--bot", pepper.id, "--text", "Please schedule a recurring inbox check. Show me the confirmation card."]);
  await until(() => existsSync(fixture.fixtureDumpPath));
  const captured = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents;
  const proxy = spawn(process.execPath, ["--experimental-strip-types", join(root, "server/drivers/agents-proxy.ts")], {
    env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: dirname(process.execPath), ...captured.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const reply = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP proposal timed out")), 15_000);
      const lines = createInterface({ input: proxy.stdout });
      lines.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id === 1) { clearTimeout(timer); lines.close(); resolve(response); }
        } catch (error) {
          clearTimeout(timer); lines.close(); reject(error);
        }
      });
      proxy.once("error", (error) => { clearTimeout(timer); reject(error); });
      proxy.once("exit", () => { clearTimeout(timer); reject(new Error("MCP exited before replying")); });
    });
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "propose_routine", arguments: { name: "Agent-created inbox check", instructions: "Summarize the test inbox. No external services.", schedule: { type: "interval", every_minutes: 5 } },
    } }) + "\n");
    const result = await reply;
    if (result.error || result.result?.isError) throw new Error(JSON.stringify(result));
    evidence.push({ tool: "propose_routine", result });
  } finally { await waitForExit(proxy, { signal: "SIGTERM" }); }
  writeFileSync(gate, "finish the isolated setup turn");
  await control(["wait", "--bot", pepper.id, "--timeout", "15"]);
  const { project: resultsFolder } = await api("POST", `/api/bots/${pepper.id}/projects`, { name: "OMB management", emoji: "🛠️" });
  const { task: resultsTask } = await api("POST", `/api/bots/${pepper.id}/tasks`, { title: "Fleet health reports", projectId: resultsFolder.id });
  await api("POST", `/api/bots/${pepper.id}/tasks/${pepper.threadId}`, {});
  const manual = await api("POST", "/api/routines", {
    name: "Manual inbox check", prompt: "Summarize the test inbox. No external services.", botId: pepper.id,
    resultsThreadId: resultsTask.threadId,
    enabled: true, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  });
  for (let index = 0; index < 2; index++) {
    const { run } = await api("POST", `/api/routines/${manual.routine.id}/run`);
    await until(async () => (await api("GET", "/api/routines")).runs.some((candidate: { id: string; status: string }) => candidate.id === run.id && candidate.status === "completed"));
  }
  const failed = await api("POST", "/api/routines", {
    name: "Provider failure example", prompt: "Exercise the isolated failing provider.", botId: miso.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  });
  await api("POST", `/api/routines/${failed.routine.id}/run`);
  const scheduled = await api("POST", "/api/routines", {
    name: "Automatic scheduled check", prompt: "Verify the scheduler dispatches without Run now.", botId: pepper.id,
    enabled: true, schedule: { type: "once", at: Date.now() + 12_000 },
  });
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/__routines.html", title: "Isolated OpenMaus Routines",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, pepperId: pepper.id, misoId: miso.id, scheduledRoutineId: scheduled.routine.id, manualRoutineId: manual.routine.id, resultsThreadId: resultsTask.threadId, resultsFolderId: resultsFolder.id }));
  await parkUntilSignal();
} finally {
  const final = await api("GET", "/api/routines").catch(() => null);
  // Ctrl-C can reach the child before this owner reads its API. Preserve the
  // actual persisted records before fixture cleanup, without calling them an API response.
  const routineFile = join(fixture.info.dataDir, "routines.json");
  const persisted = !final && existsSync(routineFile) ? JSON.parse(readFileSync(routineFile, "utf8")) : undefined;
  writeFileSync(`${fixture.info.logPath}.json`, JSON.stringify({ evidence, final, persisted }, null, 2));
  await ui?.close();
  await fixture.close();
}
