// A real server, the fake Claude engine and the real installed Edu (skipped where none is installed, as on CI). A turn
// proposes canonical notes through the mounted `edu` server; Edu Bot cards them and a person decides. HOME, the global
// Edu brain and the data folder are temporary.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { locateEduCli } from "./edu-brain.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const cli = locateEduCli({ PATH: process.env.PATH }, process.env.PATH ?? "");

const client = (fixture: VerificationServer, token?: string) => async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};

/** Modification times under the person's own ~/.edu, which no step here may touch. */
function realBrainTimes(): string {
  const root = join(homedir(), ".edu");
  const walk = (dir: string, depth: number): string[] => {
    try {
      return [`${dir} ${statSync(dir).mtimeMs}`, ...(depth > 0 ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .flatMap((entry) => walk(join(dir, entry.name), depth - 1)) : [])];
    } catch {
      return [];
    }
  };
  return walk(root, 3).join("\n");
}

async function until<T>(read: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 250));
  }
}

it.skipIf(!cli)("cards a bot's canonical proposals; only a person approves them, and Edu then holds the note as accepted", async () => {
  const before = realBrainTimes();
  const eduHome = mkdtempSync(join(tmpdir(), "edu-fixture-home-"));
  const propose = (title: string, body: string) => ({ server: "edu", name: "edu_propose_canonical", input: { kind: "standard", title, body } });
  const fixture = await launchVerificationServer({
    EDU_FIXTURE_HOME: eduHome,
    OMB_EDU_CLI: cli!,
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      propose("Use ISO dates", "Dates as YYYY-MM-DD."),
      propose("Short answers", "Answers stay short."),
      propose("Metric units", "Use metric units."),
      propose("Service check", "Only a person approves this."),
    ]),
  });
  const api = client(fixture);
  const edu = (...args: string[]) => execFileSync(process.execPath, [cli!, ...args],
    { env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, EDU_HOME: eduHome }, encoding: "utf8" });
  try {
    const bot = (await api("POST", "/api/bots", { name: "Luna" })).body.bot;
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Keep these standards", "--url", fixture.info.url]);
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "90", "--url", fixture.info.url]);
    const brain = join(fixture.info.dataDir, "brains", bot.id);
    const cards = async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[]).filter((row) => row.card?.eduProposal);
    const posted = await until(async () => { const found = await cards(); return found.length === 4 ? found : undefined; });
    const byId = (id: string) => posted.find((row) => row.card.eduProposal.id === id)!;
    expect(byId("K-use-iso-dates").card).toMatchObject({ tool: "edu_propose_canonical", options: ["Approve", "Reject"],
      eduProposal: { brain, global: false, kind: "standard", body: "Dates as YYYY-MM-DD." } });

    const iso = byId("K-use-iso-dates").card.requestId;
    const shell = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: iso, behavior: "allow" });
    expect(shell.status, JSON.stringify(shell.body)).toBe(403);
    expect(shell.body.error).toMatch(/desktop app or from a paired device/);

    const opened = await api("POST", "/api/auth/pairing", { label: "Owner phone", scopes: ["admin", "client"] });
    const owner = client(fixture, (await api("POST", "/api/auth/pair", { code: opened.body.code })).body.token);
    const approved = await owner("POST", `/api/threads/${bot.threadId}/respond`, { requestId: iso, behavior: "allow" });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    const accepted = readdirSync(join(brain, ".edu", "brain", "1-canonical", "standard")).find((file) => file.includes("use-iso-dates"))!;
    expect(readFileSync(join(brain, ".edu", "brain", "1-canonical", "standard", accepted), "utf8")).toMatch(/^status: accepted$/m);

    const rejected = await api("POST", `/api/bots/${bot.id}/edu/proposals/K-short-answers`, { action: "reject" });
    expect(rejected, JSON.stringify(rejected.body)).toMatchObject({ status: 200, body: { outcome: "rejected" } });
    expect((await api("POST", `/api/bots/${bot.id}/edu/proposals/K-metric-units`, { action: "approve" })).status).toBe(403);

    edu("--cwd", brain, "brain", "approve", "K-metric-units", "--yes", "--json");
    const view = await owner("GET", `/api/bots/${bot.id}/edu`);
    expect(view.body).toMatchObject({ state: "ready", brain, home: eduHome, mayApprove: true });
    expect(view.body.proposals.map((proposal: { id: string }) => proposal.id)).toEqual(["K-service-check"]);

    const settled = await cards();
    const answer = (id: string) => settled.find((row) => row.card.eduProposal.id === id)!.card;
    expect(answer("K-use-iso-dates").answered).toBe("allow");
    expect(answer("K-short-answers").answered).toBe("deny");
    expect(answer("K-metric-units")).toMatchObject({ answered: "unavailable", dismissed: true });

    const decisions = await until(async () => {
      const rows = ((await owner("GET", "/api/decisions")).body.decisions as any[]).filter((row) => row.tool === "edu_propose_canonical");
      return rows.length === 6 ? rows : undefined;
    });
    expect(decisions.map((row) => row.decision).sort()).toEqual(["card-shown", "card-shown", "card-shown", "card-shown", "user-approved", "user-denied"]);

    // The same data folder under service trust: every local request is a service, as a bot's shell is on a shared server.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env = { ...verificationServerEnvironment({ ...process.env, EDU_FIXTURE_HOME: eduHome, OMB_EDU_CLI: cli! }, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      OMB_LOOPBACK_TRUST: "service" };
    const serviced = spawn(process.execPath, verificationServerArgs(env), { cwd: join(import.meta.dirname, ".."), env, stdio: "ignore" });
    try {
      await until(async () => (await fetch(`${fixture.info.url}/api/health`).then((response) => response.ok, () => false)) || undefined);
      const service = client(fixture);
      const check = byId("K-service-check").card.requestId;
      const refused = await service("POST", `/api/threads/${bot.threadId}/respond`, { requestId: check, behavior: "allow" });
      expect(refused, JSON.stringify(refused.body)).toMatchObject({ status: 403 });
      expect(refused.body.error).toMatch(/can only reject/);
      expect((await service("POST", `/api/bots/${bot.id}/edu/proposals/K-service-check`, { action: "approve" })).status).toBe(403);
      expect(JSON.parse(edu("--cwd", brain, "brain", "proposals", "--json")).map((proposal: { id: string }) => proposal.id)).toEqual(["K-service-check"]);
      const declined = await service("POST", `/api/threads/${bot.threadId}/respond`, { requestId: check, behavior: "deny" });
      expect(declined, JSON.stringify(declined.body)).toMatchObject({ status: 200, body: { outcome: "rejected" } });
      expect(JSON.parse(edu("--cwd", brain, "brain", "proposals", "--json"))).toEqual([]);
    } finally {
      await waitForExit(serviced, { signal: "SIGTERM" });
    }
  } finally {
    await fixture.close();
    await removeTempDir(eduHome);
  }
  expect(realBrainTimes()).toBe(before);
}, 240_000);
