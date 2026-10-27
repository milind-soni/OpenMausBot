// Real server, two fake Claude accounts: the first one's test message fails. One miss moves nothing; a second (here
// the person's own Check again) moves the new-bot default and the first bot to the one that answered, and a restart
// keeps what was learned. A saved default is never tested or moved.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
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

/** `claude`'s connection check fails; `spare`'s answers. */
function freshHome(extra: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omb-tested-ai-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(home, "spare-claude"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: {
      claude: { driver: "claudeAgent", displayName: "Silent Claude", config: { cli: FAKE_CLI },
        environment: { FAKE_CLAUDE_CHECK: "fail", FAKE_CLAUDE_CHECK_LOG: join(home, "claude-checks.jsonl") } },
      spare: { driver: "claudeAgent", displayName: "Spare Claude", config: { cli: FAKE_CLI, configDir: join(home, "spare-claude") },
        environment: { FAKE_CLAUDE_CHECK_LOG: join(home, "spare-checks.jsonl") } },
    },
    ...extra,
  }));
  return home;
}

async function boot(home: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    // Background test messages are off in test fixtures unless asked for.
    env: { ...verificationServerEnvironment(process.env, home, port), OMB_AI_CHECKS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json() as Promise<any>;
  };
  const sent = (instance: string) => existsSync(join(home, `${instance}-checks.jsonl`))
    ? readFileSync(join(home, `${instance}-checks.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).prompt as string) : [];
  const tests = async () => Object.fromEntries(((await api("GET", "/api/instances")).instances as Array<{ instanceId: string; aiTest?: string }>)
    .filter((instance) => instance.instanceId === "claude" || instance.instanceId === "spare")
    .map((instance) => [instance.instanceId, instance.aiTest ?? null]));
  const starter = async () => ((await api("GET", "/api/bots?messages=0")).bots as Array<{ chiefOfStaff?: boolean; modelSelection: { instanceId: string } }>)
    .find((bot) => bot.chiefOfStaff)!;
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { api, sent, tests, starter, stop };
}

it("moves nothing on one miss, then the default and the untouched first bot to the AI that answered, and remembers it", async () => {
  const home = freshHome();
  const server = await boot(home);
  await expect.poll(server.tests, { timeout: 30_000, interval: 250 }).toEqual({ claude: "failed", spare: null });
  expect(server.sent("claude")).toEqual(["This is a connection check. Reply with the single word OK."]);
  const failed = (await server.api("GET", "/api/instances")).instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
  expect(failed.aiTestError).toEqual(expect.any(String));
  expect((await server.starter()).modelSelection.instanceId).toBe("claude");
  // The person's Check again misses too: twice in a row, so Claude didn't answer.
  expect(await server.api("POST", "/api/instances/claude/check", {})).toMatchObject({ ok: false });
  await expect.poll(server.tests, { timeout: 30_000, interval: 250 }).toEqual({ claude: "failed", spare: "passed" });
  await expect.poll(async () => (await server.starter()).modelSelection.instanceId, { timeout: 10_000 }).toBe("spare");
  const made = await server.api("POST", "/api/bots", { name: "Made after the test" });
  expect(made.bot.modelSelection.instanceId).toBe("spare");
  // A restart sends no new test message: the results are kept for a day.
  await server.stop();
  const again = await boot(home);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(await again.tests()).toEqual({ claude: "failed", spare: "passed" });
  expect([again.sent("claude").length, again.sent("spare").length]).toEqual([2, 1]);
  expect((await again.starter()).modelSelection.instanceId).toBe("spare");
}, 90_000);

it("never tests or moves a saved default", async () => {
  const server = await boot(freshHome({ defaultModelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }));
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(await server.tests()).toEqual({ claude: null, spare: null });
  expect(server.sent("claude")).toEqual([]);
  expect((await server.starter()).modelSelection.instanceId).toBe("claude");
}, 60_000);
