// Real settings and store against a disposable fake-engine server.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, REPO_ROOT, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
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
  `], { cwd: REPO_ROOT, env: { ...process.env, OMB_DATA_DIR: fixture.info.dataDir } });

  ui = await mountPreview(fixture, {
    entry: "/src/testing/bot-settings.tsx", route: "/__bot-settings.html", title: "Isolated Bot Settings",
    extraRoutes: [{
      // An outside edit of a bot's standing instructions, inside the fixture home only.
      path: /^\/__fixture\/drift\/([\w-]+)$/, method: "POST",
      handler(_req, res, match) {
        const botId = match![1]!;
        res.setHeader("content-type", "application/json");
        if (!ids.has(botId)) { res.writeHead(404).end('{"error":"unknown fixture bot"}'); return; }
        writeFileSync(join(fixture.info.dataDir, "bots", botId, "SOUL.md"), "Outside edit from isolated settings fixture.", { mode: 0o600 });
        res.end('{"ok":true}');
      },
    }],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
