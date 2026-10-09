// Actual Sidebar against a disposable fake-engine server; never the live app.
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  for (const name of ["Sidebar Atlas", "Sidebar Juniper"]) {
    await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  }
  // Opt-in bulk-read case. Only the fixture's synthetic provider and data
  // are used; never seed or run work in a person's installed workspace.
  if (process.argv.includes("--unread")) {
    const api = fixtureApi(fixture.info.url);
    const { bots } = await api("GET", "/api/bots?messages=0");
    const atlas = bots.find((bot: { name: string }) => bot.name === "Sidebar Atlas");
    const folder = (await api("POST", `/api/bots/${atlas.id}/projects`, { name: "Reports" })).project;
    for (let i = 0; i < 12; i++) {
      await api("POST", `/api/bots/${atlas.id}/tasks`, { title: `Webhook report ${i + 1}`, ...(i % 2 ? { projectId: folder.id } : {}) });
      await api("PATCH", `/api/bots/${atlas.id}`, { unread: true });
    }
    const working = (await api("POST", `/api/bots/${atlas.id}/tasks`, { title: "Working report" })).task;
    const wrapper = join(fixture.info.dataDir, "read-fixture-claude.mjs");
    writeFileSync(wrapper, ["#!/usr/bin/env node", 'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(join(fixture.info.dataDir, "finish-read-fixture"))};`,
      `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url))).href)});`,
    ].join("\n"));
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    await api("POST", `/api/bots/${atlas.id}/messages`, { threadId: working.threadId, text: "Keep this fixture turn running" });
    await api("PATCH", `/api/bots/${atlas.id}`, { unread: true });
    // A sibling waits on capacity; a plain follow-up to Claude's running
    // thread would steer into that turn rather than exercise the queue.
    const queued = (await api("POST", `/api/bots/${atlas.id}/tasks`, { title: "Queued report" })).task;
    const receipt = await api("POST", `/api/bots/${atlas.id}/messages`, { threadId: queued.threadId, text: "Queued report must survive reading" });
    if (!receipt.queued) throw new Error("the read fixture must retain a queued report");
    await api("PATCH", `/api/bots/${atlas.id}`, { unread: true });
    writeFileSync(join(fixture.info.dataDir, "bulk-read-before.json"), JSON.stringify(await api("GET", "/api/bots"), null, 2));
  }
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/sidebar-preview.tsx", route: "/__sidebar-preview.html", title: "Isolated Sidebar Test",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
