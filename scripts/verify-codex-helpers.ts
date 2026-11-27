// Real chat renderer and harness; offline, scripted Codex protocol only.
// No user data, provider credentials or authenticated inference are involved.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const wrapper = join(fixture.info.dataDir, "offline-codex-helpers.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'process.env.FAKE_CODEX_MODE = "helper-events";',
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-codex-app-server.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  const configPath = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.codex = {
    driver: "codex", displayName: "Codex", config: { cli: wrapper },
    environment: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, CODEX_HOME: join(fixture.info.dataDir, ".codex") },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await api("PUT", "/api/config", { defaultModelSelection: { instanceId: "codex", model: "gpt-fake-default" } });
  const created = await runControlOmb(["new-bot", "--name", "Codex Helper Fixture", "--url", fixture.info.url]) as { bot: { id: string } };
  await runControlOmb(["set-model", "--bot", created.bot.id, "--instance", "codex", "--model", "gpt-fake-default", "--url", fixture.info.url]);
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/__codex-helpers.html", title: "Codex helper isolation — offline fixture",
    extraRoutes: [{ path: "/favicon.ico", handler: (_req, res) => { res.writeHead(204); res.end(); } }],
  });
  const info = { ...fixture.info, launcherPid: process.pid, previewUrl: ui.previewUrl };
  console.log(JSON.stringify(info));
  if (process.env.OMB_HELPER_EVIDENCE) writeFileSync(process.env.OMB_HELPER_EVIDENCE, JSON.stringify(info, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
