// Real Settings and API against an offline Codex CLI in a disposable home.
// No real provider credentials, executable, or network login is used.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const fixtureHome = fixture.info.dataDir;
  const codexDir = join(fixtureHome, ".codex");
  const wrapper = join(fixtureHome, "offline-codex-account.mjs");
  const commandLog = join(fixtureHome, "offline-codex-commands.jsonl");
  const failLogoutMarker = join(fixtureHome, ".omb-fake-codex-logout-fail");
  writeFileSync(failLogoutMarker, "Disposable forced-error fixture. Remove to test retry.\n", { mode: 0o600 });
  mkdirSync(codexDir, { recursive: true });
  // Account identity comes from the fake app-server's account/read response;
  // the disposable CODEX_HOME stays empty and holds no credential-shaped file.
  writeFileSync(join(fixtureHome, ".omb-fake-codex-authenticated"), "Offline fixture; not a credential.\n", { mode: 0o600 });
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { appendFileSync, existsSync, unlinkSync } from "node:fs";',
    `if (process.env.OMB_DEVICE_AUTH_FIXTURE !== "1" || process.env.HOME !== ${JSON.stringify(fixtureHome)} || process.env.CODEX_HOME !== ${JSON.stringify(codexDir)}) { throw new Error("Disposable Codex fixture environment required"); }`,
    `appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(process.argv.slice(2)) + "\\n", { mode: 0o600 });`,
    'if (process.argv.slice(2).join(" ") === "logout") {',
    `  if (existsSync(${JSON.stringify(failLogoutMarker)})) { process.stderr.write("Offline fixture forced logout failure\\n"); process.exit(1); }`,
    `  for (const file of ${JSON.stringify([join(fixtureHome, ".omb-fake-codex-authenticated"), join(fixtureHome, ".omb-fake-codex-login-approved")])}) { if (existsSync(file)) unlinkSync(file); }`,
    '  process.stdout.write("Successfully logged out\\n");',
    "} else {",
    `  await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../server/testing/fake-codex-login-cli.ts", import.meta.url))).href)});`,
    "}",
  ].join("\n"), { mode: 0o700 });

  // The standard launcher owns this file and home. The harmless default-model
  // write makes the isolated server reread it and reload the provider registry.
  const configPath = join(fixtureHome, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.codex = {
    driver: "codex", displayName: "Codex", config: { cli: wrapper },
    environment: { HOME: fixtureHome, USERPROFILE: fixtureHome, CODEX_HOME: codexDir, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_CODEX_ACCOUNT_EMAIL: "ada@example.test" },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await api("PUT", "/api/config", { defaultModelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
  await runControlOmb(["new-bot", "--name", "Codex Account Fixture", "--url", fixture.info.url]);
  const { instances } = await api("GET", "/api/instances");
  const codex = instances.find((instance: { instanceId: string }) => instance.instanceId === "codex");
  if (codex?.snapshot.authenticated !== true || codex.snapshot.account?.email !== "ada@example.test") {
    throw new Error(`Synthetic account not ready: ${JSON.stringify(codex?.snapshot)}`);
  }

  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/__codex-account.html", title: "Codex account — offline fixture",
  });
  console.log(JSON.stringify({ ...fixture.info, launcherPid: process.pid, commandLog, failLogoutMarker, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
