// Full app, real routes and fake provider in one disposable home.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const longActivity = process.argv.includes("--long-activity");
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  await control(["new-bot", "--name", "Pepper"]);
  await control(["new-bot", "--name", "Miso"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const pepper = bots.find((bot: { name: string }) => bot.name === "Pepper");
  const miso = bots.find((bot: { name: string }) => bot.name === "Miso");
  await api("PUT", "/api/config", { profile: { name: "Threads preview" } });
  const { project: folder } = await api("POST", `/api/bots/${pepper.id}/projects`, { name: "Email" });
  const { instances } = await api("GET", "/api/instances");
  const models = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude").models.options;
  let gmailThread = pepper.threadId;
  const titles = ["Website ideas", "Triage Gmail", "Triage iCloud"];
  if (process.argv.some(arg => arg === "--check-panes" || arg === "--try-panes")) {
    titles.push("Reading list");
    await api("PATCH", `/api/bots/${miso.id}/tasks/${miso.threadId}`, { title: "Release notes" });
  }
  for (const [index, title] of titles.entries()) {
    const threadId = index === 0 ? pepper.threadId : (await api("POST", `/api/bots/${pepper.id}/tasks`, { title, projectId: folder.id })).task.threadId;
    await api("PATCH", `/api/bots/${pepper.id}/tasks/${threadId}`, {
      title, modelSelection: { instanceId: "claude", model: models[index % models.length].id },
    });
    await control(["send", "--bot", pepper.id, "--task", threadId, "--text", title]);
    await control(["wait", "--bot", pepper.id, "--task", threadId, "--timeout", "15"]);
    if (index === 1) gmailThread = threadId;
  }
  const { group } = await api("POST", "/api/groups", { name: "Launch team", memberIds: [pepper.id, miso.id] });
  await api("POST", `/api/groups/${group.id}/tasks`, { title: "Launch planning" });
  await api("POST", `/api/groups/${group.id}/tasks`, { title: "Weekly review" });
  await api("POST", `/api/bots/${pepper.id}/tasks/${gmailThread}`, {});

  const fakeCli = fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url));
  if (longActivity) {
    const calls = Array.from({ length: 211 }, (_, index) => ({
      name: "Bash", input: { command: `mkdir -p reports/section-${String(index + 1).padStart(3, "0")}` }, ok: true, output: "Done",
    }));
    const callsFile = join(fixture.info.dataDir, "audit-steps.json");
    writeFileSync(callsFile, JSON.stringify(calls));
    const auditCli = join(fixture.info.dataDir, "audit-claude.mjs");
    writeFileSync(auditCli, [
      "#!/usr/bin/env node",
      `process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = ${JSON.stringify(callsFile)};`,
      `await import(${JSON.stringify(pathToFileURL(fakeCli).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: auditCli });
    await control(["send", "--bot", pepper.id, "--task", pepper.threadId, "--text", "Prepare a folder for each section of the website audit."]);
    await control(["wait", "--bot", pepper.id, "--task", pepper.threadId, "--timeout", "60"]);
  }

  // New sends remain in flight for deterministic switching/Stop checks.
  // Creating finishGate (only inside this fixture home) completes them.
  const finishGate = join(fixture.info.dataDir, "finish-preview-turns");
  const wrapper = join(fixture.info.dataDir, "preview-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { basename, join } from "node:path";',
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    process.argv.includes("--try-panes") ? 'process.env.FAKE_CLAUDE_SLOW_MS = "12000";' :
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(finishGate)};`,
    // Fixture-only launch receipts let a verifier exercise the same live
    // permission broker as the provider, without accessing real accounts.
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, basename(process.cwd()) + ".launch.json");`,
    `await import(${JSON.stringify(pathToFileURL(fakeCli).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Isolated OpenMaus Threads",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, finishGate }));
  if (process.argv.includes("--check-panes")) {
    const { verifyWorkspacePanes } = await import("./testing/workspace-panes.ts");
    await verifyWorkspacePanes(ui.previewUrl, finishGate, fixture.info.logPath + ".panes.png", longActivity, async () => {
      const { task } = await api("POST", `/api/bots/${pepper.id}/tasks/${pepper.threadId}/forks`, { latest: true });
      return task.threadId;
    });
  } else await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
