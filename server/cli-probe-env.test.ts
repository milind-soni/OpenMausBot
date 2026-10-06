// The two routes that launch an executable chosen in Settings with a copy of
// the server's own environment: the pre-save CLI probe (POST /api/cli-test)
// and the Claude Code update (POST /api/instances/:id/claude-update). Over
// the real HTTP boundary, with every credential the shared lists name
// (config.ts) in that environment, neither hands one on; PATH, HOME and
// proxy settings still arrive. Disposable home; no network; a stub
// executable that records the environment it was given.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CONTROL_PLANE_ENV, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "./config.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Every name on the shared lists, and one more under the control plane's
// OMB_CLOUD_ prefix, so a credential added to a list later is covered too.
// Not the hosted model pair: a desktop holding either refuses to boot unless
// it is a complete portal-managed workspace (hosted-models.ts).
const HOSTED_ONLY = ["OMB_HOSTED_MODELS", "OMB_HOSTED_MODEL_TOKEN"];
const secretNames = [...new Set<string>([
  ...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV, ...CONTROL_PLANE_ENV, "OMB_CLOUD_FIXTURE_TOKEN",
])].filter((name) => !HOSTED_ONLY.includes(name));
const secrets: Record<string, string> = Object.fromEntries(secretNames.map((name) => {
  const unique = randomBytes(12).toString("hex");
  return [name, name.endsWith("_URL") ? `https://fixture-${unique}.example.test/v1` : `fixture-${name.toLowerCase()}-${unique}`];
}));
const kept = { HTTPS_PROXY: "http://proxy.example.test:3128", NO_PROXY: "localhost,127.0.0.1" };
let home: string;
let base: string;
let child: ChildProcess;
let log = "";

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** `node <stub>` plus fixed arguments, as a wrapper string the Engines panel
 * accepts: no shebang or exec bit, so it runs the same on every platform. */
const stubCli = (...fixed: string[]) =>
  [process.execPath, join(home, "stub-cli.mjs"), ...fixed].map((part) => JSON.stringify(part)).join(" ");

function expectNoCredentials(file: string) {
  const env = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  // Proves the dump is the server's environment, not an empty one.
  expect(env.HOME).toBe(home);
  expect(env.PATH?.split(delimiter)).toEqual(expect.arrayContaining(process.env.PATH!.split(delimiter).filter(Boolean)));
  expect(env).toMatchObject(kept);
  const leaked = secretNames.filter((name) => name in env);
  expect(leaked).toEqual([]);
  const dumped = JSON.stringify(env);
  expect(Object.keys(secrets).filter((name) => dumped.includes(secrets[name]))).toEqual([]);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cli-probe-env-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  // Answers like a signed-in Claude Code; `probe` (the CLI test) and
  // `update` (the Claude update) record the environment they ran with.
  writeFileSync(join(home, "stub-cli.mjs"), `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "probe" || args[0] === "update") writeFileSync(join(${JSON.stringify(home)}, args[0] + "-env.json"), JSON.stringify(process.env));
if (args[0] === "auth") console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
else if (args.at(-1) === "--version") console.log("9.9.9 (Claude Code)");
`);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      // Pin the fleet's other defaults so this never probes an installed CLI.
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "mistral", "qwen", "hermes", "pi", "omp"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: stubCli() } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      ...kept,
      ...secrets,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok && (await health.json() as { pid?: number }).pid === child.pid) break;
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("probes a CLI chosen in Settings without handing it any credential the server holds", async () => {
  const probe = await post("/api/cli-test", { cli: stubCli("probe") });
  expect(probe.body, JSON.stringify(probe.body)).toMatchObject({ ok: true, version: "9.9.9 (Claude Code)" });
  expectNoCredentials(join(home, "probe-env.json"));
});

it("updates Claude Code without handing the updater any credential the server holds", async () => {
  const updated = await post("/api/instances/claude/claude-update", {});
  expect(updated.body, JSON.stringify(updated.body)).toEqual({ ok: true, version: "9.9.9 (Claude Code)" });
  expectNoCredentials(join(home, "update-env.json"));
});
