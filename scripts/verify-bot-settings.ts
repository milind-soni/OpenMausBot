// Real settings and store against a disposable fake-engine server.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  for (const name of ["Settings Atlas", "Settings Juniper"]) {
    await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  }
  const { bots } = await fetch(`${fixture.info.url}/api/bots`).then((r) => r.json()) as { bots: Array<{ id: string; name: string }> };
  const ids = new Set(bots.map((bot) => bot.id));
  for (const bot of bots) {
    await fetch(`${fixture.info.url}/api/bots/${bot.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: `${bot.name} fixture blurb.`, soul: `Original standing instructions for ${bot.name}.` }),
    });
  }
  const atlas = bots.find((bot) => bot.name === "Settings Atlas")!;
  // The installer writes only to this launcher's disposable data directory.
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { installSkill, setSkillEnabled } from './server/skills.ts';
    const result = installSkill(${JSON.stringify(atlas.id)}, 'fixture:settings', [{path:'SKILL.md',content:'---\\nname: fixture-check\\ndescription: Check fixture settings reliably\\n---\\nRead the fixture state and summarize it.\\n'}]);
    if ('error' in result) throw new Error(result.error);
    setSkillEnabled(${JSON.stringify(atlas.id)}, 'fixture-check', true);
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, OMB_DATA_DIR: fixture.info.dataDir } });

  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-bot-settings", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/__bot-settings.html") {
          void server.transformIndexHtml(req.url, '<html><head><title>Isolated Bot Settings</title></head><body><div id="root"></div><script type="module" src="/src/testing/bot-settings.tsx"></script></body></html>')
            .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
          return;
        }
        const match = req.url?.match(/^\/__fixture\/drift\/([\w-]+)$/);
        if (match && req.method === "POST" && ids.has(match[1]!)) {
          writeFileSync(join(fixture.info.dataDir, "bots", match[1]!, "SOUL.md"), "Outside edit from isolated settings fixture.", { mode: 0o600 });
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
          return;
        }
        next();
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `${ui.resolvedUrls!.local[0]}__bot-settings.html` }));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await ui?.close();
  await fixture.close();
}
