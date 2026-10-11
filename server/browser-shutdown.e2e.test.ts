// The agent-browser daemon outlives the MCP transport that started it, so a
// server that only stopped its transports left the daemon and its Chrome
// running after a quit, until the engine's one-hour idle timeout. Real server,
// fake Claude CLI, and an agent-browser stub that logs each command it gets.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

/** Run one browser turn for a bot that works on the browser, then stop the
 * server the way quitting the app does. Returns the commands the stub got
 * during shutdown: preparing a session also closes it once, during the turn. */
async function browserTurnThenQuit(config: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "omb-browser-shutdown-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const log = join(home, "agent-browser.log");
  const engine = join(home, "agent-browser");
  // `session list` answers with no sessions, so a close counts as finished.
  writeFileSync(engine, [
    "#!/bin/sh",
    `printf '%s %s\\n' "$AGENT_BROWSER_SESSION" "$*" >> '${log}'`,
    `if [ "$1" = session ]; then printf '%s\\n' '{"success":true,"data":{"sessions":[]}}'; fi`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    features: { browser: true },
    instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI } } },
    ...config,
  }));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: { ...verificationServerEnvironment(process.env, home, port), OMB_AGENT_BROWSER_PATH: engine },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const bot = (await api("POST", "/api/bots", { name: "Shutdown probe" })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Check the website." })).status).toBe(202);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
    .find((item: { id: string }) => item.id === bot.id)?.busy, { timeout: 20_000 }).toBe(false);
  const turnCommands = readFileSync(log, "utf8").trim().split("\n");
  expect(turnCommands.some((line) => line.startsWith(`bot-${bot.id} `))).toBe(true);
  appendFileSync(log, "--- shutdown\n");
  await waitForExit(child, { signal: "SIGTERM" });
  return { session: `bot-${bot.id}`, commands: readFileSync(log, "utf8").split("--- shutdown\n")[1].trim().split("\n") };
}

// The stub is a POSIX shell script; Windows resolves engines through a
// separate launch contract.
describe.skipIf(process.platform === "win32")("closing the browsers at shutdown", () => {
  it("closes the browser a bot used when the server stops", async () => {
    const { session, commands } = await browserTurnThenQuit();
    expect(commands).toContain(`${session} close`);
  }, 60_000);

  it("leaves a Chrome attached over CDP running", async () => {
    const { session, commands } = await browserTurnThenQuit({ browserEngine: { attachCdpUrl: "9222" } });
    expect(commands).not.toContain(`${session} close`);
  }, 60_000);
});
