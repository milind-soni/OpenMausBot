import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { launchRestartableServer, type RestartableServer } from "../testing/restartable-server.ts";

type Rec = Record<string, any>;
const ROOT = join(import.meta.dirname, "..", "..");
const ACME = join(ROOT, "server", "testing", "fixtures", "profiles", "acme");
const posixOnly = describe.skipIf(process.platform === "win32");

interface Person { name: string; server: RestartableServer; token: string }
let scratch: string;
let repo: string;
let folder: string;
const people: Person[] = [];

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Profiles Test", "-c", "user.email=profiles@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(scratch, "no-gitconfig") },
  }).trim();
}
function commit(path: string, edit: (text: string) => string, message: string): string {
  const file = join(folder, path);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  git("commit", "-qam", message);
  return git("rev-parse", "HEAD");
}

async function api(person: Person, method: string, path: string, body?: unknown, admin = false): Promise<{ status: number; body: Rec }> {
  const res = await fetch(`${person.server.url}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(admin ? { authorization: `Bearer ${person.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Rec };
}
const plan = async (person: Person, extra: Rec = {}) => (await api(person, "POST", "/api/profiles/plan", { folder, ...extra })).body;
async function apply(person: Person, extra: Rec = {}) {
  const result = await api(person, "POST", "/api/profiles/apply", { folder, giveAccess: true, ...extra }, true);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}
const decisions = (body: Rec) => (body.lines as Rec[]).filter((line) => ["add", "change", "access", "conflict", "remove"].includes(line.kind));

/** A person's bots as the profiles made them, without ids, times or anything that belongs to one computer. */
async function projection(person: Person): Promise<Rec[]> {
  const bots = ((await api(person, "GET", "/api/bots?messages=0")).body.bots as Rec[]).filter((bot) => bot.profileSource);
  const rows = [];
  for (const bot of bots) {
    const skills = ((await api(person, "GET", `/api/bots/${bot.id}/skills`)).body.skills as Rec[]).map((skill) => ({ name: skill.name, enabled: skill.enabled, sha256: skill.sha256 }));
    rows.push({
      profile: `${bot.profileSource.area}/${bot.profileSource.key}`, name: bot.name, title: bot.title, description: bot.description, soul: bot.soul, section: bot.section,
      approvalMode: bot.approvalMode, toolScope: bot.toolScope ?? null, toolsOff: bot.toolsOff ?? [], mcpServers: bot.mcpServers ?? null, connectorTools: bot.connectorTools ?? null,
      eduBrain: bot.eduBrain ?? null, eduCrew: bot.eduCrew === true, memoryEnabled: bot.memoryEnabled !== false, memoryUpkeep: bot.memoryUpkeep !== false,
      modelSelection: bot.modelSelection, chiefOfStaff: bot.chiefOfStaff === true, commit: bot.profileSource.commit, hashes: bot.profileSource.hashes, skills,
    });
  }
  return rows.sort((a, b) => a.profile.localeCompare(b.profile));
}
const botOf = async (person: Person, key: string) => ((await api(person, "GET", "/api/bots?messages=0")).body.bots as Rec[]).find((bot) => bot.profileSource?.key === key)!;

posixOnly("two people, one profile repository", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-two-people-"));
    repo = join(scratch, "acme-repo");
    folder = join(repo, "edubot");
    mkdirSync(repo);
    cpSync(ACME, folder, { recursive: true });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "Acme profiles");
    for (const name of ["A", "B"]) {
      const server = await launchRestartableServer();
      await server.stop();
      const registry = new SessionRegistry({ file: join(server.dataDir, "sessions.json") });
      const token = registry.issue({ label: `${name}'s laptop`, scopes: ["admin", "client"] }).token;
      registry.close();
      await server.start();
      people.push({ name, server, token });
    }
  }, 120_000);

  afterAll(async () => {
    for (const person of people) await person.server.close();
    if (scratch) await removeTempDir(scratch);
  });

  it("gives both people the same bots from the same commit", async () => {
    const head = git("rev-parse", "HEAD");
    for (const person of people) {
      const planned = await plan(person);
      expect(planned).toMatchObject({ commit: head, organization: "Acme", problems: [] });
      const applied = await apply(person, { expect: planned.digest });
      expect(applied.applied.skipped).toEqual([]);
    }
    const [a, b] = await Promise.all(people.map(projection));
    expect(a.map((bot) => bot.profile)).toEqual(["bi/analyst", "bi/reporter", "sales/closer"]);
    expect(a.every((bot) => bot.commit === head)).toBe(true);
    expect(a.find((bot) => bot.profile === "bi/analyst")).toMatchObject({ eduCrew: true, chiefOfStaff: true, section: "BI", approvalMode: "auto", mcpServers: ["notion"] });
    expect(b).toEqual(a);
  });

  it("says No changes when the same commit is applied again", async () => {
    for (const person of people) expect(decisions(await plan(person))).toEqual([]);
    const cli = spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "openmausbot.ts"), "profiles", "apply", folder, "--url", people[1]!.server.url], {
      cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch }, timeout: 60_000,
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim().split("\n").at(-1)).toBe("No changes.");
  });

  it("brings a new commit to both", async () => {
    const head = commit("areas/bi/bots/analyst.md", (text) => text.replace("Check every number against its source before you report it.", "Check every number twice."), "Stricter analyst");
    for (const person of people) {
      expect(decisions(await plan(person)).map((line) => line.text)).toEqual(["Analista BI: instructions 1 line changed"]);
      await apply(person);
      expect((await botOf(person, "analyst")).soul).toBe("You are the BI area's analyst.\n\nCheck every number twice.");
    }
    const [a, b] = await Promise.all(people.map(projection));
    expect(a.every((bot) => bot.commit === head)).toBe(true);
    expect(b).toEqual(a);
  });

  it("shows a conflict only to the person who changed the field here", async () => {
    const [a, b] = people as [Person, Person];
    const local = await api(a, "PATCH", `/api/bots/${(await botOf(a, "analyst")).id}`, { title: "A's own analyst" });
    expect(local.status).toBe(200);
    commit("areas/bi/bots/analyst.md", (text) => text.replace("title: Data analyst", "title: Senior data analyst"), "Retitle analyst");

    const planA = await plan(a);
    expect(decisions(planA)).toEqual([expect.objectContaining({ kind: "conflict", text: 'Analista BI: title: the file says "Senior data analyst", you have "A\'s own analyst"',
      conflict: { choice: "bi/analyst:title", file: '"Senior data analyst"', mine: '"A\'s own analyst"' } })]);
    expect(decisions(await plan(b)).map((line) => line.text)).toEqual(['Analista BI: title "Data analyst" → "Senior data analyst"']);

    await apply(a);
    await apply(b);
    expect((await botOf(a, "analyst")).title).toBe("A's own analyst");
    expect((await botOf(b, "analyst")).title).toBe("Senior data analyst");
    expect(decisions(await plan(a)).map((line) => line.kind)).toEqual(["conflict"]);

    await apply(a, { choices: { "bi/analyst:title": "file" } });
    expect((await botOf(a, "analyst")).title).toBe("Senior data analyst");
    expect(decisions(await plan(a))).toEqual([]);
    expect(await projection(b)).toEqual(await projection(a));
  });

  it("records --keep-mine from the command line even when it is the only thing to apply", async () => {
    const [a] = people as [Person, Person];
    expect((await api(a, "PATCH", `/api/bots/${(await botOf(a, "analyst")).id}`, { title: "A's analyst again" })).status).toBe(200);
    commit("areas/bi/bots/analyst.md", (text) => text.replace("title: Senior data analyst", "title: Lead data analyst"), "Retitle analyst again");
    expect(decisions(await plan(a)).map((line) => line.kind)).toEqual(["conflict"]);
    const cli = spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "openmausbot.ts"), "profiles", "apply", folder,
      "--keep-mine", "bi/analyst:title", "--url", a.server.url], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch }, timeout: 60_000 });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).not.toContain("No changes.");
    expect(decisions(await plan(a))).toEqual([]);
    expect((await botOf(a, "analyst")).title).toBe("A's analyst again");
  });
});
