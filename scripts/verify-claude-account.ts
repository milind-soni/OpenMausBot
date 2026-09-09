// Real Settings against an offline Claude CLI, confined to a disposable home.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-claude-account", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__claude-account.html") return next();
        void server.transformIndexHtml(req.url, '<!doctype html><html><head><meta charset="utf-8"><title>Claude account — offline fixture</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/threads-preview.tsx"></script></body></html>')
          .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, commandLog, failLogoutMarker, previewUrl: `${ui.resolvedUrls!.local[0]}__claude-account.html` }));
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} finally {
  await ui?.close();
  await fixture.close();
}
