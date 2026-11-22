// Two Edu Bot fixtures share one real edu-cloud brain, started from an edu-cloud build with per-person credentials
// (EDU_CLOUD_CLI names its dist/cli.js; skipped without one, as on CI) on a temporary data folder and a loopback port.
// Ana's bot on fixture A remembers and proposes; Luis's bot on fixture B recalls it. Ana's member token cannot approve the
// proposal; Luis's steward token can. Nothing reads or writes the person's own ~/.edu or ~/.edu-cloud.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { EDU_CLOUD_RELAY_PATH } from "./edu-cloud.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { launchRestartableServer, type RestartableServer } from "./testing/restartable-server.ts";

type Rec = Record<string, any>;
const CLI = process.env.EDU_CLOUD_CLI?.trim() ?? "";
const runs = Boolean(CLI) && existsSync(CLI) && process.platform !== "win32";
const SECRET_NAME = "EDU_CLOUD_BI";

/** The person's own brains, which no step may touch: each folder's mtime, or null when it does not exist. */
function ownBrainTimes(): Record<string, number | null> {
  const folders = [".edu", ".edu/brain", ".edu/brain/1-canonical", ".edu/brain/2-episodic", ".edu/brain/3-transitive", ".edu-cloud", ".edu-cloud/auth"];
  return Object.fromEntries(folders.map((folder) => {
    const path = join(homedir(), folder);
    return [path, existsSync(path) ? statSync(path).mtimeMs : null];
  }));
}

interface Fixture { server: RestartableServer; admin: string }

async function fixture(toolCalls: unknown[]): Promise<Fixture> {
  const server = await launchRestartableServer();
  await server.stop();
  const registry = new SessionRegistry({ file: join(server.dataDir, "sessions.json"), emailScopes: () => ["client"] });
  const admin = registry.issue({ label: "Owner's laptop", scopes: ["admin", "client"] }).token;
  registry.close();
  const before = process.env.FAKE_CLAUDE_TOOL_CALLS;
  process.env.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify(toolCalls);
  try {
    await server.start();
  } finally {
    if (before === undefined) delete process.env.FAKE_CLAUDE_TOOL_CALLS;
    else process.env.FAKE_CLAUDE_TOOL_CALLS = before;
  }
  return { server, admin };
}

async function api(on: Fixture, method: string, path: string, body?: unknown, asAdmin = true): Promise<{ status: number; body: Rec; text: string }> {
  const res = await fetch(`${on.server.url}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(asAdmin ? { authorization: `Bearer ${on.admin}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Rec = {};
  try { parsed = JSON.parse(text) as Rec; } catch {}
  return { status: res.status, body: parsed, text };
}

async function turn(on: Fixture, bot: Rec, text: string): Promise<void> {
  await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", on.server.url]);
  await runControlOmb(["wait", "--bot", bot.id, "--timeout", "90", "--url", on.server.url]);
}

describe.skipIf(!runs)("cloud Edu brain shared by two people", () => {
  let scratch: string;
  let cloud: ChildProcess | undefined;
  let url: string;
  const tokens: Record<"member" | "steward", string> = { member: "", steward: "" };
  let a: Fixture;
  let b: Fixture;
  let ana: Rec;
  let luis: Rec;
  let timesBefore: Record<string, number | null>;

  beforeAll(async () => {
    timesBefore = ownBrainTimes();
    scratch = mkdtempSync(join(tmpdir(), "edu-cloud-brain-"));
    const data = join(scratch, "cloud");
    const env = { PATH: process.env.PATH ?? "", HOME: join(scratch, "home"), EDU_CLOUD_HOME: data };
    const context = join(scratch, "context.md");
    writeFileSync(context, "# BI area\nThe BI area's shared memory.\n");
    const run = (args: string[]) => execFileSync(process.execPath, [CLI, ...args, "--data-dir", data], { env, encoding: "utf8" });
    run(["init", "--context", context]);
    tokens.member = (JSON.parse(run(["token", "add", "ana@example.com", "--team", "bi", "--scope", "member"])) as { secret: string }).secret;
    tokens.steward = (JSON.parse(run(["token", "add", "luis@example.com", "--team", "bi", "--scope", "steward"])) as { secret: string }).secret;
    const port = await freePortBlock([0]);
    cloud = spawn(process.execPath, [CLI, "serve", "--data-dir", data, "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let said = "";
      const timer = setTimeout(() => reject(new Error(`edu-cloud did not start: ${said}`)), 20_000);
      cloud!.stderr!.on("data", (chunk: Buffer) => {
        said += String(chunk);
        if (said.includes("listening")) { clearTimeout(timer); resolve(); }
      });
      cloud!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`edu-cloud exited ${code}: ${said}`)); });
    });
    url = `http://127.0.0.1:${port}/mcp`;

    a = await fixture([
      { server: "edu", name: "edu_remember", input: { tier: "transitive", kind: "decision", band: "inferred", title: "Cloud fixture decision", body: "BI reports close on Fridays." } },
      { server: "edu", name: "edu_propose_canonical", input: { kind: "domain", title: "Revenue means net revenue", body: "Net of returns and discounts." } },
    ]);
    b = await fixture([{ server: "edu", name: "edu_recall", input: { query: "cloud fixture decision" } }]);
    for (const [on, token, name] of [[a, tokens.member, "Ana's analyst"], [b, tokens.steward, "Luis's analyst"]] as const) {
      expect((await api(on, "POST", "/api/vault/secrets", { name: SECRET_NAME, value: token, bots: "all" })).status).toBe(201);
      const bot = (await api(on, "POST", "/api/bots", { name })).body.bot as Rec;
      const setting = { eduBrain: { mode: "cloud", url, token: { secret: SECRET_NAME } } };
      expect((await api(on, "PATCH", `/api/bots/${bot.id}`, setting, false)).status).toBe(403);
      expect((await api(on, "PATCH", `/api/bots/${bot.id}`, setting)).status).toBe(200);
      if (on === a) ana = bot; else luis = bot;
    }
  }, 240_000);

  afterAll(async () => {
    await a?.server.close();
    await b?.server.close();
    cloud?.kill("SIGTERM");
    if (scratch) await removeTempDir(scratch);
  });

  it("mounts edu-cloud as the edu server and never shows the token", async () => {
    for (const [on, bot, token] of [[a, ana, tokens.member], [b, luis, tokens.steward]] as const) {
      const edu = await api(on, "GET", `/api/bots/${bot.id}/edu`);
      expect(edu.body).toMatchObject({ state: "ready", mode: "cloud", brain: url, cloud: { url, token: SECRET_NAME, review: true } });
      for (const path of [`/api/bots/${bot.id}/edu`, "/api/vault", `/api/bots/${bot.id}`, "/api/bots?messages=0"]) {
        expect((await api(on, "GET", path)).text).not.toContain(token);
      }
    }
    expect((await api(a, "GET", `/api/bots/${ana.id}/edu`)).body.cloud).toMatchObject({ label: "ana@example.com", scope: "member" });
    expect((await api(b, "GET", `/api/bots/${luis.id}/edu`)).body.cloud).toMatchObject({ label: "luis@example.com", scope: "steward" });
  });

  it("lets a bot on one computer recall what a bot on the other remembered", async () => {
    await turn(a, ana, "Remember that BI reports close on Fridays");
    const said = readFileSync(join(a.server.dataDir, "fake-claude-dump.json"), "utf8");
    expect(said, "no MCP config, argument or engine variable holds the person's token").not.toContain(tokens.member);
    const relay = JSON.parse(JSON.parse(said).mcpConfig.mcpServers.edu.env.OMB_REMOTE_MCP_SERVER) as { url: string; headers: { authorization: string } };
    expect(relay.url).toBe(`${new URL(a.server.url).origin.replace("localhost", "127.0.0.1")}${EDU_CLOUD_RELAY_PATH}`);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const afterTurn = await fetch(relay.url, { method: "POST", headers: { authorization: relay.headers.authorization, "content-type": "application/json" }, body: JSON.stringify(ping) });
    expect(afterTurn.status, "the turn's capability ends with the turn").toBe(401);

    await turn(b, luis, "When do BI reports close?");
    const transcript = (await api(b, "GET", `/api/threads/${luis.threadId}/messages?limit=100`)).text;
    expect(transcript).toContain("Cloud fixture decision");
  }, 240_000);

  it("shows the proposal to the member read-only, and only the steward's token approves it", async () => {
    const seenByAna = (await api(a, "GET", `/api/bots/${ana.id}/edu`)).body;
    expect(seenByAna.mayApprove).toBe(false);
    const proposal = (seenByAna.proposals as Rec[]).find((candidate) => candidate.title === "Revenue means net revenue");
    expect(proposal).toMatchObject({ cloud: true, brain: url, body: "Net of returns and discounts." });
    const refused = await api(a, "POST", `/api/bots/${ana.id}/edu/proposals/${encodeURIComponent(proposal!.id)}`, { action: "approve" });
    expect(refused).toMatchObject({ status: 403, body: { error: "Only a steward of this edu-cloud brain can approve or reject its proposals." } });

    const seenByLuis = (await api(b, "GET", `/api/bots/${luis.id}/edu`)).body;
    expect(seenByLuis.mayApprove).toBe(true);
    expect((seenByLuis.proposals as Rec[]).map((candidate) => candidate.id)).toContain(proposal!.id);
    const fromScript = await api(b, "POST", `/api/bots/${luis.id}/edu/proposals/${encodeURIComponent(proposal!.id)}`, { action: "reject" }, false);
    expect(fromScript.status).toBe(403);
    const approved = await api(b, "POST", `/api/bots/${luis.id}/edu/proposals/${encodeURIComponent(proposal!.id)}`, { action: "approve" });
    expect(approved).toMatchObject({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    expect((await api(a, "GET", `/api/bots/${ana.id}/edu`)).body.proposals).toEqual([]);
  }, 120_000);

  it("left the person's own ~/.edu and ~/.edu-cloud untouched", () => {
    expect(ownBrainTimes()).toEqual(timesBefore);
  });
});
