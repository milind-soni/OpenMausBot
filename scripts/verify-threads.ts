// Full app, real routes and fake provider in one disposable home.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
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
  for (const [index, title] of ["Website ideas", "Triage Gmail", "Triage iCloud"].entries()) {
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

  // New sends remain in flight for deterministic switching/Stop checks.
  // Creating finishGate (only inside this fixture home) completes them.
  const finishGate = join(fixture.info.dataDir, "finish-preview-turns");
  const wrapper = join(fixture.info.dataDir, "preview-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { basename, join } from "node:path";',
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(finishGate)};`,
    // Fixture-only launch receipts let a verifier exercise the same live
    // permission broker as the provider, without accessing real accounts.
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, basename(process.cwd()) + ".launch.json");`,
    `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url))).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-threads", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__threads.html") return next();
        void server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Isolated OpenMaus Threads</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/threads-preview.tsx"></script></body></html>')
          .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `${ui.resolvedUrls!.local[0]}__threads.html`, finishGate }));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await ui?.close();
  await fixture.close();
}
