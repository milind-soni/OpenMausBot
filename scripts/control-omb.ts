#!/usr/bin/env -S node --experimental-strip-types
// The openmausbot headless verbs for verifying an isolated fixture. A verb that
// changes something never runs on a server it merely found.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { EXIT, HeadlessError } from "../server/headless/args.ts";
import { runHeadlessCommand } from "../server/headless/main.ts";
import type { handleToolCall, request } from "./mcp-server.ts";
import { launchUi, runControlOmbUi } from "./testing/control-omb-ui.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Outside the bot name pool, so no suite can plan a bot that collides with the
 * starter. */
export const FIXTURE_STARTER_BOT_NAME = "Fixture Starter";
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");

export class ControlOmbError extends HeadlessError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.failed, hint);
  }
}

export interface ControlOmbDependencies {
  callTool?: typeof handleToolCall;
  request?: typeof request;
  env?: NodeJS.ProcessEnv;
}

export const HELP_UI = `renderer (needs a ui launch handle; every verb takes --ui HANDLE, never discovery):
  node --experimental-strip-types scripts/control-omb.ts ui launch [--entry threads] [--tool-calls JSON] [--mode happy]
  ui snapshot --ui HANDLE [--interactive]
  ui click --ui HANDLE (--ref @eN | --name NAME)
  ui type --ui HANDLE (--ref @eN | --name NAME) --text TEXT
  ui press --ui HANDLE --keys KEYS
  ui screenshot --ui HANDLE --out PATH.png
  ui console --ui HANDLE
  ui eval --ui HANDLE --js CODE
  ui flag --ui HANDLE --set features.NAME=VALUE [--dry-run]
  ui wait-settle --ui HANDLE [--timeout 30]
  ui help`;

export const HELP = `control-omb — the openmausbot headless verbs (docs/headless-cli.md), for verifying a fixture

read-only (every verb also takes --url URL):
  doctor
  bots
  channels
  models
  messages --bot ID [--task ID] [--limit 30]
  messages --channel ID [--task ID] [--limit 30]
  wait --bot ID [--task ID] [--timeout 30] [--for job|turn]
  wait --channel ID [--task ID] [--timeout 30]
  export --thread ID --out DIR
  events --job THREAD_ID --until-settled

mutating (an explicit --url or OPENMAUSBOT_URL/OMB_PORT is required):
  new-bot --name NAME [--section TEAM]
  new-channel --name NAME --members ID,ID
  send --bot ID --text TEXT [--task ID] [--dry-run]
  send-channel --channel ID --text TEXT [--task ID] [--dry-run]
  run --bot ID --text TEXT [--wait job|turn|none] [--timeout 5m] [--export DIR]
  interrupt --bot ID [--task ID] [--tree] [--dry-run]
  interrupt --channel ID [--task ID] [--dry-run]
  edit --bot ID --message ID --text TEXT [--task ID] [--dry-run]
  set-model --bot ID --instance ID --model ID [--task ID] [--effort LEVEL] [--dry-run]
  team apply FILE [--dry-run | --check]

${HELP_UI}

isolated fixture:
  node --experimental-strip-types scripts/control-omb.ts launch

Output is JSON. wait defaults to 30 seconds here. launch and ui launch own a temporary fake-engine server until interrupted.`;

const commonOptions = {
  url: { type: "string" },
} satisfies ParseArgsOptionsConfig;

export function parse(
  command: string,
  args: string[],
  options: ParseArgsOptionsConfig = {},
): Record<string, unknown> & { url?: string } {
  try {
    return parseArgs({
      args,
      options: { ...commonOptions, ...options },
      strict: true,
      allowPositionals: false,
    }).values as Record<string, unknown> & { url?: string };
  } catch (error) {
    throw new ControlOmbError(
      error instanceof Error ? error.message : String(error),
      `run control-omb help for the ${command} syntax`,
    );
  }
}

export async function runControlOmb(
  argv: string[],
  dependencies: ControlOmbDependencies = {},
): Promise<unknown> {
  const [command = "help", ...args] = argv;
  if (command === "help" || command === "--help" || command === "-h") return HELP;
  if (command === "launch") throw new ControlOmbError("launch is available only from the executable CLI");
  if (command === "ui") return runControlOmbUi(args);
  return runHeadlessCommand(argv, {
    env: dependencies.env ?? process.env,
    ...(dependencies.callTool ? { callTool: dependencies.callTool } : {}),
    ...(dependencies.request ? { request: dependencies.request } : {}),
    requireExplicitForMutations: true,
    defaultWaitMs: 30_000,
  });
}

export interface VerificationServer {
  info: { url: string; pid: number; dataDir: string; logPath: string };
  fixtureDumpPath: string;
  child: ChildProcess;
  close(): Promise<void>;
}

/** A temporary home in `dataDir`, the fake engine's knobs from `parentEnv`, node
 * on PATH, and nothing else from the parent shell or this machine's CLIs. */
export function verificationServerEnvironment(parentEnv: NodeJS.ProcessEnv, dataDir: string, port: number): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  const platformKeys = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]);
  for (const [key, value] of Object.entries(parentEnv)) {
    const normalized = key.toUpperCase();
    if (value && platformKeys.has(normalized)) childEnv[normalized] = value;
  }
  const fixtureTemp = join(dataDir, "tmp");
  Object.assign(childEnv, {
    HOME: dataDir,
    USERPROFILE: dataDir,
    APPDATA: join(dataDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(dataDir, "AppData", "Local"),
    XDG_CONFIG_HOME: join(dataDir, ".config"),
    XDG_CACHE_HOME: join(dataDir, ".cache"),
    XDG_DATA_HOME: join(dataDir, ".local", "share"),
    TEMP: fixtureTemp,
    TMP: fixtureTemp,
    TMPDIR: fixtureTemp,
    HERMES_HOME: join(dataDir, ".hermes"),
    OMB_DATA_DIR: dataDir,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    // A caller's FAKE_CLAUDE_MODE overrides this below to drive failure paths.
    FAKE_CLAUDE_MODE: parentEnv.FAKE_CLAUDE_MODE || "happy",
    FAKE_CLAUDE_DUMP: join(dataDir, "fake-claude-dump.json"),
    // POSIX resolves the fake CLI's `#!/usr/bin/env node` shebang through PATH;
    // Windows resolves it through spawnCli without a shell.
    PATH: dirname(process.execPath),
    // Without it the server also scans /opt/homebrew/bin, /usr/local/bin and the
    // login shell's PATH, finding a developer's own engine CLIs that CI lacks.
    OMB_TEST_SEALED_PATH: "1",
  });
  // The fake engines' knobs are the one thing a caller may script into the child.
  for (const [key, value] of Object.entries(parentEnv)) {
    // FAKE_CLAUDE_DUMP stays the launcher's: assertions read fixtureDumpPath.
    if ((key.startsWith("FAKE_CLAUDE_") || key.startsWith("FAKE_CODEX_TEXT_")) && key !== "FAKE_CLAUDE_DUMP" && value) childEnv[key] = value;
  }
  // Enables POST /api/testing/org-library; the route does not exist without it.
  if (parentEnv.OMB_TEST_ORG_LIBRARY_KEY) childEnv.OMB_TEST_ORG_LIBRARY_KEY = parentEnv.OMB_TEST_ORG_LIBRARY_KEY;
  // One log line per browser call and preview frame.
  if (parentEnv.OMB_BROWSER_TIMING === "1") childEnv.OMB_BROWSER_TIMING = "1";
  // A loopback fake only: the key never reaches a real provider.
  const liveUrl = parentEnv.OMB_OPENAI_LIVE_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(liveUrl)) {
    childEnv.OMB_OPENAI_LIVE_URL = liveUrl;
    if (parentEnv.OMB_OPENAI_LIVE_KEY) childEnv.OMB_OPENAI_LIVE_KEY = parentEnv.OMB_OPENAI_LIVE_KEY;
  }
  // A loopback connected-apps service only (server/testing/broker-fake.ts): its token never reaches the real one.
  const brokerUrl = parentEnv.OMB_COMPOSIO_BROKER_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(brokerUrl) && parentEnv.OMB_COMPOSIO_BROKER_TOKEN) {
    childEnv.OMB_COMPOSIO_BROKER_URL = brokerUrl;
    childEnv.OMB_COMPOSIO_BROKER_TOKEN = parentEnv.OMB_COMPOSIO_BROKER_TOKEN;
  }
  // Research against loopback stubs only (server/x-research.e2e.test.ts): the relay token crosses only with its stub,
  // and a treg stand-in replaces treg.to, so no test reaches a real relay or treg.
  const xUrl = parentEnv.OMB_CLOUD_X_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}(?:\/[A-Za-z0-9_-]+)*$/.test(xUrl)) {
    childEnv.OMB_CLOUD_X_URL = xUrl;
    if (parentEnv.OMB_CLOUD_X_TOKEN) childEnv.OMB_CLOUD_X_TOKEN = parentEnv.OMB_CLOUD_X_TOKEN;
  }
  const tregUrl = parentEnv.OMB_TREG_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(tregUrl)) childEnv.OMB_TREG_URL = tregUrl;
  // Loopback only, for harness mechanics: a fake ElevenLabs the measurement
  // substrate can drive without a key. Never a real address.
  const elevenApi = parentEnv.OMB_ELEVENLABS_API?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(elevenApi)) childEnv.OMB_ELEVENLABS_API = elevenApi;
  // Live calls need Pro; without it the fixture refuses a call with 402 needsPro.
  if (parentEnv.OMB_PRO_PLAN?.trim() === "1") childEnv.OMB_PRO_PLAN = "1";
  // Arms the one-shot audio-append failure inside the fixture server.
  if (parentEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE) {
    childEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE = parentEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE;
  }
  // The Claude broker's approval deadline fires on a marker file, not after 15 minutes.
  if (parentEnv.OMB_TEST_APPROVAL_CLOCK === "1") childEnv.OMB_TEST_APPROVAL_CLOCK = "1";
  // The stall watchdog fires on a marker file, not after 20 minutes of silence.
  if (parentEnv.OMB_TEST_STALL_CLOCK === "1") childEnv.OMB_TEST_STALL_CLOCK = "1";
  // The UI checks drive this fixture from a real browser, as `pnpm dev` does; OMB_DEV_TRUST_LOCAL_BROWSER=0 tests the sign-in.
  if (parentEnv.OMB_DEV_TRUST_LOCAL_BROWSER !== "0") childEnv.OMB_DEV_TRUST_LOCAL_BROWSER = "1";
  // Desktop mode: the owner capability the app would hand the server.
  if (parentEnv.OMB_TEST_DESKTOP_OWNER_TOKEN) {
    childEnv.OMB_TEST_DESKTOP_OWNER_TOKEN = parentEnv.OMB_TEST_DESKTOP_OWNER_TOKEN;
    childEnv.OMB_DESKTOP_PARENT = "1";
  }
  return childEnv;
}

/** The fixture hooks its environment asks for, then the server. */
export function verificationServerArgs(childEnv: NodeJS.ProcessEnv): string[] {
  const hook = (file: string) => ["--import", pathToFileURL(join(ROOT, "server", "testing", file)).href];
  return [
    "--experimental-strip-types",
    ...(childEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE === "1" ? hook("fail-audio-append-once.mjs") : []),
    ...(childEnv.OMB_TEST_DESKTOP_OWNER_TOKEN ? hook("desktop-parent.mjs") : []),
    ...(childEnv.OMB_TEST_APPROVAL_CLOCK === "1" ? hook("approval-clock-hooks.mjs") : []),
    ...(childEnv.OMB_TEST_STALL_CLOCK === "1" ? hook("stall-clock-hooks.mjs") : []),
    join(ROOT, "server", "index.ts"),
  ];
}

/** Start one foreground-owned, fake-engine server with no access to user data. */
export async function launchVerificationServer(
  parentEnv: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  localVm?: { binDir: string; host: string; sshKey: string; staticDir: string },
  browser?: { binaryPath: string; executablePath: string },
  /** A stand-in enterprise layer (the folder shape core loads) and the key
   * it should accept, so a recipe can prove entitled behaviour offline. */
  enterprise?: { dir: string; licenseKey: string },
  room?: { scripted: boolean },
  /** Optional repository-owned fake providers for multi-engine setup checks. */
  extraProviders: Array<"codex" | "cline"> = [],
  /** Programmatic tests only: an owned loopback Boat provider, never a live account. */
  boatFixtureApi?: string,
  /** Programmatic web UI qualification against the fixture's static server. */
  staticDir?: string,
): Promise<VerificationServer> {
  if (boatFixtureApi) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(boatFixtureApi)) {
      throw new ControlOmbError("Boat verification requires an explicit loopback HTTP provider");
    }
    try { new URL(boatFixtureApi); }
    catch { throw new ControlOmbError("Boat verification requires a valid loopback port"); }
  }
  if (localVm) {
    const endpoint = new URL(localVm.host);
    if (endpoint.protocol !== "ssh:" || endpoint.hostname !== "127.0.0.1" || endpoint.password) {
      throw new ControlOmbError("Local VM verification requires an explicit loopback Podman machine");
    }
  }
  // OMB_TEST_PORTS=19975-19999 keeps a recipe's fixture in a range of its own.
  const range = /^(\d+)-(\d+)$/.exec((parentEnv.OMB_TEST_PORTS ?? process.env.OMB_TEST_PORTS)?.trim() ?? "");
  const port = range ? await freePortBlock([0, 1], Number(range[1]), Number(range[2]) - Number(range[1])) : await freePortBlock([0, 1]);
  if (signal?.aborted) throw new ControlOmbError("verification launch cancelled");
  const url = `http://127.0.0.1:${port}`;
  // Native browser daemons use UNIX sockets, and a macOS temp home can exceed
  // their path limit.
  const dataDir = mkdtempSync(join(browser && process.platform !== "win32" ? "/tmp" : tmpdir(), "openmausbot-verify-data-"));
  const fixtureTemp = join(dataDir, "tmp");
  const fixtureDumpPath = join(dataDir, "fake-claude-dump.json");
  mkdirSync(fixtureTemp, { recursive: true });
  const evidenceDir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `server-${Date.now()}-${process.pid}.log`);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    ...(boatFixtureApi ? { box: { token: "box_verification_fixture" } } : {}),
    instances: {
      ...(extraProviders.includes("codex") ? { codex: {
        driver: "codex", displayName: "Verification Codex", config: { cli: fileURLToPath(new URL("../server/testing/fake-codex-app-server.ts", import.meta.url)) },
      } } : {}),
      ...(extraProviders.includes("cline") ? { cline: {
        driver: "clineAgent", displayName: "Verification Cline",
        config: { cli: fileURLToPath(new URL("../server/testing/fake-acp-cli.ts", import.meta.url)) },
        environment: { CLINE_PROVIDER: "openai-compatible", CLINE_MODEL: "fixture-model", CLINE_API_KEY: "fixture-only",
          FAKE_ACP_DUMP: join(dataDir, "cline-launch.json") },
      } } : {}),
      claude: {
        driver: "claudeAgent",
        displayName: "Verification fixture",
        config: { cli: FAKE_CLI },
        ...(room?.scripted ? { environment: { FAKE_CLAUDE_ROOM_PLAN: join(dataDir, "room-plan.json") } } : {}),
      },
    },
  }, null, 2));

  const log = openSync(logPath, "a", 0o600);
  const childEnv = verificationServerEnvironment(parentEnv, dataDir, port);
  // Opt-in live Local VM fixture: keep the temporary home and fake engine,
  // granting only the explicitly selected machine connection and static UI.
  if (localVm) Object.assign(childEnv, {
    OMB_EXTRA_PATH: [localVm.binDir, ...(process.platform === "win32" ? [join(childEnv.SYSTEMROOT || "C:\\Windows", "System32")] : [])].join(delimiter),
    CONTAINER_HOST: localVm.host,
    CONTAINER_SSHKEY: localVm.sshKey,
    OMB_STATIC_DIR: localVm.staticDir,
  });
  if (enterprise) Object.assign(childEnv, { OMB_ENTERPRISE_DIR: enterprise.dir, OMB_LICENSE_KEY: enterprise.licenseKey });
  if (browser) Object.assign(childEnv, {
    OMB_AGENT_BROWSER_PATH: browser.binaryPath,
    AGENT_BROWSER_EXECUTABLE_PATH: browser.executablePath,
  });
  if (boatFixtureApi) childEnv.OMB_BOAT_API = boatFixtureApi;
  if (staticDir) childEnv.OMB_STATIC_DIR = staticDir;
  const child = spawn(process.execPath, verificationServerArgs(childEnv), {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", log, log],
  });
  closeSync(log);

  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      if (signal?.aborted) throw new ControlOmbError("verification launch cancelled");
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`verification server exited before it was ready; see ${logPath}`);
      }
      try {
        const timeout = AbortSignal.timeout(1_000);
        const response = await fetch(`${url}/api/health`, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const body = response.ok ? await response.json() as { app?: string } : null;
        if (body?.app === "openmausbot") break;
      } catch {
      }
      if (Date.now() >= deadline) throw new Error(`verification server did not become ready; see ${logPath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    throw error;
  }

  // Pinned: the random starter name shares a pool with names e2e suites plan.
  try {
    // First-run filesystem work can exceed a second on Windows.
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const list = await fetch(`${url}/api/bots`, {
      headers: { origin: url },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = list.ok ? await list.json() as { bots?: Array<{ id: string }> } : null;
    const seeded = body?.bots;
    if (!Array.isArray(seeded) || seeded.length !== 1) {
      throw new Error(`verification fixture did not seed exactly one starter bot; see ${logPath}`);
    }
    const renameTimeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const rename = await fetch(`${url}/api/bots/${seeded[0].id}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ name: FIXTURE_STARTER_BOT_NAME }),
      signal: signal ? AbortSignal.any([signal, renameTimeout]) : renameTimeout,
    });
    if (!rename.ok) throw new Error(`verification starter rename failed (${rename.status}); see ${logPath}`);
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    throw error;
  }

  let closed = false;
  return {
    info: { url, pid: child.pid!, dataDir, logPath },
    fixtureDumpPath,
    child,
    async close() {
      if (closed) return;
      closed = true;
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(dataDir);
    },
  };
}

export function controlResultSucceeded(command: string, result: unknown): boolean {
  if (command === "doctor") return (result as { ok?: unknown })?.ok === true;
  if (command === "wait") return (result as { status?: unknown })?.status === "settled";
  if (command === "ui" || command === "run" || command === "team") return (result as { ok?: unknown })?.ok !== false;
  return true;
}

/** pnpm swallows Ctrl-C; a launcher that owns processes must get the signal itself. */
function requireForegroundTerminal(command: string): void {
  if (process.env.npm_lifecycle_event === "control:omb") {
    throw new ControlOmbError(
      `${command} must own the terminal directly so Ctrl-C can clean up its children`,
      `run \`node --experimental-strip-types scripts/control-omb.ts ${command}\``,
    );
  }
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "ui" && process.argv[3] === "launch") {
    requireForegroundTerminal("ui launch");
    await launchUi(process.argv.slice(4));
    return;
  }
  if (command === "launch") {
    requireForegroundTerminal("launch");
    const startup = new AbortController();
    const cancelStartup = () => startup.abort();
    process.once("SIGINT", cancelStartup);
    process.once("SIGTERM", cancelStartup);
    let session: VerificationServer;
    try {
      session = await launchVerificationServer(process.env, startup.signal);
    } finally {
      process.removeListener("SIGINT", cancelStartup);
      process.removeListener("SIGTERM", cancelStartup);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...session.info }, null, 2)}\n`);
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void session.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      session.child.once("close", () => {
        if (!stopping) {
          stopping = true;
          process.exitCode = 1;
          process.stderr.write(`${JSON.stringify({
            ok: false,
            error: `verification server exited unexpectedly; see ${session.info.logPath}`,
          }, null, 2)}\n`);
          void removeTempDir(session.info.dataDir).finally(resolve);
        }
      });
    });
    return;
  }
  const result = await runControlOmb(process.argv.slice(2));
  process.stdout.write(typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
  if (!controlResultSucceeded(command, result)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failure = error instanceof HeadlessError
      ? { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}) }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  });
}
