import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const ENTRY = join(import.meta.dirname, "openmausbot.ts");

interface Ran { code: number | null; stdout: string; stderr: string }

let session: VerificationServer;
let dir: string;

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
      env: { ...process.env, OPENMAUSBOT_TOKEN: "", OMB_PORT: "", OPENMAUSBOT_URL: session.info.url, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`openmausbot ${args.join(" ")} did not finish: ${stderr}`)); }, 90_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const json = (ran: Ran) => JSON.parse(ran.stdout);
const botsNow = async () => json(await cli(["bots", "--json"])).bots as any[];

beforeAll(async () => {
  // A port range of its own (19975-19999), and a scripted fake engine.
  session = await launchVerificationServer({ ...process.env, OMB_TEST_PORTS: "19975-19999" }, undefined, undefined, undefined, undefined, { scripted: true });
  dir = mkdtempSync(join(tmpdir(), "omb-headless-cli-"));
}, 60_000);

afterAll(async () => {
  await session?.close();
  if (dir) await removeTempDir(dir);
});

describe("openmausbot headless: team apply → run --wait job → export", () => {
  let model: string;
  let lead: any;
  let priya: any;
  let marcus: any;
  let teamFile: string;

  it("rehearses a launch with a Chief and two teammates and exports what they made", async () => {
    for (const folder of ["room", "priya", "marcus"]) mkdirSync(join(dir, "work", folder), { recursive: true });
    mkdirSync(join(dir, "skills", "launch-report"), { recursive: true });
    writeFileSync(join(dir, "skills", "launch-report", "SKILL.md"), "---\nname: launch-report\ndescription: How to write the launch report.\n---\nList what each visitor tried and the fixes that matter.\n");
    const doctor = await cli(["doctor", "--json"]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(json(doctor)).toMatchObject({ ok: true, server: { capabilities: { jobs: true } }, session: { kind: "loopback" } });
    model = json(await cli(["models", "--json"])).instances.find((instance: any) => instance.instanceId === "claude").models.default;
    teamFile = join(dir, "launch-room.yaml");
    writeFileSync(teamFile, `version: 1
defaults:
  team: Launch Room
  model: claude/${model}
  approval: full
  computer: "off"
  browser: { enabled: true, profile: guest }
  # Claude limits MCP tools only; this keeps a mail server's tools from every visitor
  tools: { deny: ["mcp:mail:*"] }
teams:
  - name: Launch Room
    prune: true
    brief: |
      We rehearse a product launch before it happens. Never ask the person anything.
bots:
  - name: Room Lead
    chief: true
    title: Launch rehearsal lead
    description: Hands the site to every visitor, then writes the launch report.
    cwd: ${join(dir, "work", "room")}
    browser: false
    tools: { deny: [] }
    soul: Hand the site to every visitor, then write report.md and link it.
    skills:
      - file: skills/launch-report/SKILL.md
  - name: Priya
    title: Skeptical procurement manager
    cwd: ${join(dir, "work", "priya")}
    soul: You are Priya, who buys software for a 200-person company.
  - name: Marcus
    title: Rushed founder on a phone-sized screen
    cwd: ${join(dir, "work", "marcus")}
    soul: You are Marcus, who gives a site 30 seconds.
rooms:
  - name: Debrief
    team: Launch Room
    members: [Room Lead, Priya, Marcus]
    brief: Talk over what each visitor saw.
    responder: Room Lead
`);

    const applied = await cli(["team", "apply", teamFile]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('bot "Room Lead": create (Chief of Launch Room');
    expect(applied.stdout).toContain('room "Debrief": create (3 members, team Launch Room)');
    expect(applied.stdout).toContain("Applied: 5 created, 0 changed, 0 deleted.");
    const again = await cli(["team", "apply", teamFile, "--json"]);
    expect(again.code, again.stderr).toBe(0);
    expect(json(again)).toMatchObject({ created: 0, changed: 0, deleted: 0, writes: 0, plan: [] });
    expect((await cli(["team", "apply", teamFile, "--check"])).code).toBe(0);

    const bots = await botsNow();
    const byName = (name: string) => bots.find((bot) => bot.name === name);
    [lead, priya, marcus] = ["Room Lead", "Priya", "Marcus"].map(byName);
    expect(lead).toMatchObject({ section: "Launch Room", chiefOfStaff: true, modelSelection: { instanceId: "claude", model } });
    expect([priya, marcus].every((bot) => bot.section === "Launch Room")).toBe(true);
    const room = json(await cli(["channels", "--json"])).channels.find((channel: any) => channel.name === "Debrief");
    expect(room).toMatchObject({ section: "Launch Room", bulletin: "Talk over what each visitor saw.", defaultResponder: { kind: "member", botId: lead.id } });
    expect(new Set(room.memberIds)).toEqual(new Set([lead.id, priya.id, marcus.id]));

    // Scripted: the Chief hands the site to both visitors and writes the report once both reported; each saves a screenshot.
    writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({
      [lead.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [priya.id, marcus.id], message: "Visit https://example.com as yourself and report what stopped you." } }], reply: "Briefed both visitors." },
        { writeFiles: { "report.md": "# Launch report\n\n- Priya could not find pricing.\n- Marcus left after the hero.\n" },
          reply: "Launch report: [report](report.md)" },
      ] },
      [priya.id]: { turns: [{ writeFiles: { "priya-1.png": "fake png bytes" }, reply: "Pricing was hard to find.\n\n![step 1](priya-1.png)" }] },
      [marcus.id]: { turns: [{ writeFiles: { "marcus-1.png": "fake png bytes" }, reply: "The hero did not say what it does.\n\n![step 1](marcus-1.png)" }] },
    }));

    const out = join(dir, "export");
    const run = await cli(["run", "Room Lead", "Rehearse the launch of example.com with every visitor.", "--wait", "job", "--timeout", "60s", "--json", "--export", out]);
    expect(run.code, `${run.stderr}\n${run.stdout}`).toBe(0);
    const result = json(run);
    expect(result).toMatchObject({ ok: true, exitCode: 0, status: "settled", state: "completed",
      reply: { text: "Launch report: [report](report.md)", files: ["report.md"] }, export: { ok: true } });
    const nodes = result.job.nodes as any[];
    expect(nodes.map((node) => [node.botName, node.status])).toEqual([["Room Lead", "completed"], ["Priya", "completed"], ["Marcus", "completed"]]);
    const progress = run.stderr.trim().split("\n").map((line) => JSON.parse(line));
    expect(progress[0]).toMatchObject({ event: "started", threadId: result.threadId });
    expect(progress.some((event) => event.event === "job" && event.state === "running")).toBe(true);

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ ok: true, threadId: result.threadId, state: "completed", skipped: [] });
    expect(manifest.transcripts).toHaveLength(3);
    const exported = (name: string) => manifest.files.find((file: any) => file.file.endsWith(name));
    expect(readFileSync(join(out, exported("report.md").file), "utf8")).toContain("Priya could not find pricing.");
    expect(readFileSync(join(out, exported("priya-1.png").file), "utf8")).toBe("fake png bytes");
    expect(exported("marcus-1.png")).toBeTruthy();
    const job = JSON.parse(readFileSync(join(out, "job.json"), "utf8"));
    expect(job.nodes.map((node: any) => node.result)).toEqual(["Launch report: [report](report.md)", expect.stringContaining("Pricing was hard to find."),
      expect.stringContaining("The hero did not say what it does.")]);
    const transcripts = readdirSync(join(out, "transcripts"));
    expect(transcripts.filter((name) => name.endsWith(".json"))).toHaveLength(3);
    expect(transcripts.filter((name) => name.endsWith(".md"))).toHaveLength(3);
    const leadTranscript = JSON.parse(readFileSync(join(out, manifest.transcripts[0].file), "utf8"));
    expect(leadTranscript.messages.some((message: any) => message.role === "user" && message.text.includes("Rehearse the launch"))).toBe(true);

    const refused = await cli(["export", "--thread", result.threadId, "--out", out]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("already has files in it");
    const forced = await cli(["export", "--thread", result.threadId, "--out", out, "--force", "--json"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(json(forced).files.length).toBeGreaterThanOrEqual(3);

    const waited = await cli(["wait", "--thread", result.threadId, "--json"]);
    expect(waited.code).toBe(0);
    expect(json(waited)).toMatchObject({ status: "settled", state: "idle" });
    const same = await cli(["wait", "--thread", result.threadId, "--since", String(result.since), "--json"]);
    expect(same.code).toBe(0);
    expect(json(same)).toMatchObject({ status: "settled", state: "completed", job: { reason: "Room Lead finished" } });
    expect(existsSync(join(dir, "work", "room", "report.md"))).toBe(true);
  }, 180_000);

  it("exports the team as a file that applies back unchanged, then renames and prunes from a second file", async () => {
    const exportedFile = join(dir, "exported", "team.yaml");
    mkdirSync(join(dir, "exported"), { recursive: true });
    const exported = await cli(["team", "export", "--team", "Launch Room", "--out", exportedFile, "--json"]);
    expect(exported.code, exported.stderr).toBe(0);
    expect(json(exported)).toMatchObject({ ok: true, teams: 1, bots: 3, rooms: 1, skills: 1 });
    expect(readFileSync(exportedFile, "utf8")).toContain("name: Room Lead");
    const check = await cli(["team", "apply", exportedFile, "--check"]);
    expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
    expect(check.stdout.trim()).toBe("No changes.");

    expect((await cli(["new-bot", "Old visitor", "--team", "Launch Room", "--json"])).code).toBe(0);
    const next = join(dir, "launch-room-v2.yaml");
    writeFileSync(next, readFileSync(teamFile, "utf8")
      .replace("  - name: Marcus\n", "  - name: Marcus Lee\n    was: Marcus\n")
      .replace("members: [Room Lead, Priya, Marcus]", "members: [Room Lead, Priya, Marcus Lee]"));
    const plan = await cli(["team", "apply", next, "--dry-run"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('bot "Marcus Lee": update renamed from "Marcus"');
    expect(plan.stdout).toContain('bot "Old visitor": not in file (kept; --prune deletes it)');
    expect((await cli(["team", "apply", next, "--check"])).code).toBe(6);
    const pruned = await cli(["team", "apply", next, "--prune"]);
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(pruned.stdout).toContain('bot "Old visitor": delete (not in file)');
    const bots = await botsNow();
    expect(bots.find((bot) => bot.name === "Old visitor")).toBeUndefined();
    expect(bots.find((bot) => bot.name === "Marcus Lee")?.id).toBe(marcus.id);
    expect((await cli(["team", "apply", next, "--check"])).code).toBe(0);

    const before = JSON.stringify(await botsNow());
    const native = join(dir, "native.yaml");
    writeFileSync(native, readFileSync(next, "utf8").replace('tools: { deny: ["mcp:mail:*"] }', 'tools: { deny: ["native:Bash"] }'));
    const refused = await cli(["team", "apply", native]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('bot "Priya": claudeAgent: native tool selection is not supported by this engine');
    expect(JSON.stringify(await botsNow())).toBe(before);
  }, 120_000);

  it("stops a job whose teammate hangs when its time runs out, the teammate included", async () => {
    const never = join(dir, "never-opened");
    writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({
      [lead.id]: { turns: [{}, {}, { steps: [{ arguments: { bot_ids: [priya.id], message: "Hold the line until told." } }], reply: "Asked Priya to hold." }] },
      [priya.id]: { turns: [{}, { readyFile: join(dir, "priya-holding"), gateFile: never, reply: "Released." }] },
    }));
    const run = await cli(["run", "Room Lead", "Hold the line.", "--timeout", "4s", "--on-timeout", "stop", "--json"]);
    expect(run.code, `${run.stderr}\n${run.stdout}`).toBe(4);
    const result = json(run);
    expect(existsSync(join(dir, "priya-holding"))).toBe(true);
    expect(result).toMatchObject({ ok: false, exitCode: 4, status: "timed-out", stopped: [{ botName: "Priya" }] });
    await expect.poll(async () => {
      const after = json(await cli(["wait", "--thread", result.threadId, "--since", String(result.since), "--json"]));
      return { state: after.state, nodes: after.job.nodes.map((node: any) => [node.botName, node.status]) };
    }, { timeout: 20_000, interval: 500 }).toEqual({ state: "failed", nodes: [["Room Lead", "cancelled"], ["Priya", "cancelled"]] });
    await expect.poll(async () => (await botsNow()).find((bot) => bot.id === priya.id)?.busy, { timeout: 20_000, interval: 500 }).toBe(false);
  }, 120_000);
});
