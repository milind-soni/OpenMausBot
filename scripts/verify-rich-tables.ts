// Real message-scoped file access; synthetic content and a disposable home only.
import { mkdirSync, writeFileSync } from "node:fs";
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
  await control(["new-bot", "--name", "Table reviewer"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((item: { name: string }) => item.name === "Table reviewer");
  const workspace = join(fixture.info.dataDir, "workspaces", bot.id);
  mkdirSync(workspace, { recursive: true });
  const files = {
    "sales.csv": "ID,Customer,Revenue,Notes\n" + Array.from({ length: 50_000 }, (_, i) => `${String(i).padStart(6, "0")},Customer ${i},${i + 1},${i === 49_999 ? "Final customer" : "Quarterly subscription"}`).join("\n"),
    "notes.tsv": "Name\tNotes\nAda\t\"Two lines\nhere\"\n李\tUnicode ✓",
    "broken.csv": 'Name,Value\n"unclosed,1',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(workspace, name), content);
  const reply = [
    "## Quarterly report",
    "| Customer | Revenue | Notes |\n| :--- | ---: | :--- |\n| **Ada** | 1200 | [Account](https://example.com) |\n| Lin | 90 | `renewal` |\n| Ravi | 450 | A longer note that wraps without pushing the page wider |",
    ...Object.keys(files).map((name) => `[${name}](${join(workspace, name)})`),
    "| الاسم | القيمة |\n| --- | --- |\n| مرحبا | 42 |",
  ].join("\n\n");
  const wrapper = join(fixture.info.dataDir, "tables-claude.mjs");
  writeFileSync(wrapper, ["#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  const sent = await control(["send", "--bot", bot.id, "--text", "Prepare the sample tables."]);
  await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  const { messages } = await api("GET", `/api/threads/${sent.taskId}/messages?limit=100`);
  const message = messages.find((item: { text?: string }) => item.text?.includes("Quarterly report"));
  if (!message) throw new Error("Fixture did not produce the table reply");
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/rich-tables-preview.tsx", route: "/__rich-tables.html", title: "Isolated OMB tables",
    extraRoutes: [{ path: "/__table-fixture", handler: (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: message.text, message: { threadId: sent.taskId, messageId: message.id } }));
    } }],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally { await ui?.close(); await fixture.close(); }
