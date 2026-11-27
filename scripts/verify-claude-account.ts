// Real Settings against an offline Claude CLI, confined to a disposable home.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const home = fixture.info.dataDir;
  const configDir = join(home, "claude-account");
  const authenticated = join(configDir, "authenticated");
  const failLogoutMarker = join(home, "logout-failure");
  const commandLog = join(home, "claude-commands.jsonl");
  const wrapper = join(home, "offline-claude-account.mjs");
  mkdirSync(configDir);
  writeFileSync(authenticated, "Offline fixture, not a credential.\n", { mode: 0o600 });
  writeFileSync(failLogoutMarker, "Remove only this marker to test retry.\n", { mode: 0o600 });
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { appendFileSync, existsSync, unlinkSync } from "node:fs";',
    `if (process.env.HOME !== ${JSON.stringify(home)} || process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(configDir)}) throw new Error("Disposable fixture required");`,
    'const command = process.argv.slice(2).join(" ");',
    `appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(process.argv.slice(2)) + "\\n", { mode: 0o600 });`,
    'if (command === "auth logout") {',
    `  if (existsSync(${JSON.stringify(failLogoutMarker)})) { process.stderr.write("Offline fixture forced logout failure\\n"); process.exit(1); }`,
    `  if (existsSync(${JSON.stringify(authenticated)})) unlinkSync(${JSON.stringify(authenticated)});`,
    '  process.stdout.write("Logged out\\n");',
    '} else if (command === "auth status --json") {',
    `  const loggedIn = existsSync(${JSON.stringify(authenticated)});`,
    '  process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", ...(loggedIn ? { email: "ada@example.test", orgName: "Offline fixture" } : {}) }));',
    '  process.exitCode = loggedIn ? 0 : 1;',
    '} else {',
    `  await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url))).href)});`,
    '}',
  ].join("\n"), { mode: 0o700 });
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances["claude-review"] = {
    driver: "claudeAgent", displayName: "Claude review", config: { cli: wrapper, configDir },
    environment: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await api("PUT", "/api/config", { defaultModelSelection: { instanceId: "claude-review", model: "sonnet" } });
  await runControlOmb(["new-bot", "--name", "Claude Account Fixture", "--url", fixture.info.url]);
  const { instances } = await api("GET", "/api/instances");
  const account = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude-review");
  if (account?.snapshot.account?.email !== "ada@example.test" || !account.authentication?.signOut) {
    throw new Error(`Offline account not ready: ${JSON.stringify(account)}`);
  }
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/__claude-account.html", title: "Claude account — offline fixture",
  });
  console.log(JSON.stringify({ ...fixture.info, commandLog, failLogoutMarker, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
