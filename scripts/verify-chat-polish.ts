// Real app + real file routes, entirely within a disposable fake-engine home.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  await control(["new-bot", "--name", "Pepper"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((item: { name: string }) => item.name === "Pepper");
  const workspace = join(fixture.info.dataDir, "workspaces", bot.id);
  mkdirSync(workspace, { recursive: true });
  const video = join(workspace, "demo.mp4");
  copyFileSync(join(root, "docs/screenshots/composer-dock-after.mp4"), video);
  const files = ["brief.md", "metrics.csv", "notes.txt", "next-steps.md"];
  for (const name of files) writeFileSync(join(workspace, name), `Synthetic UI fixture: ${name}\n`, "utf8");
  const image = await fetch(`${fixture.info.url}/api/attachments`, {
    method: "POST", headers: { "content-type": "image/png" },
    body: readFileSync(join(root, "docs/verification/evidence/chat-ui/chat-ui.png")),
  }).then(async (response) => { if (!response.ok) throw new Error("fixture image upload failed"); return response.json(); });
  const reply = [
    "Here are the demo recording and files for review. These are isolated test artifacts.",
    `[Demo recording](${video})`,
    ...files.map((name) => `[${name}](${join(workspace, name)})`),
  ].join("\n\n");
  const wrapper = join(fixture.info.dataDir, "polish-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};`,
    `process.env.FAKE_CLAUDE_TOOL_CALLS = ${JSON.stringify(JSON.stringify([
      { name: "Bash", input: { command: "pnpm control:omb doctor", password: "fixture-password" }, output: { text: "All fixture health checks passed.", token: "fixture-token" }, ok: true },
      { name: "Read", input: { file_path: "missing.txt" }, output: "File not found: missing.txt", ok: false },
      { name: "Search", input: { query: "release notes" }, ok: true },
    ]))};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  await api("PATCH", "/api/config", { features: { showToolCalls: true }, language: "en" });
  await control(["send", "--bot", bot.id, "--text", `Review these assets and show the tool results.\n<attached-image path="${image.path}" />`]);
  const settled = await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__chat-polish.html", title: "Isolated OMB UI polish" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, botId: bot.id, settled }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
