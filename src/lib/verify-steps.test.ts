import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { commandOf, nameIsCommand, parseControlCommand, skillPrompt, skillStaged, verifySteps, verifySummary } from "./verify-steps";
import type { Message } from "@/state/store";

let seq = 0;
/** Claude-style chip: the tool name with the command riding in `summary`. */
const claude = (command: string, ok?: boolean): Message =>
  ({ id: `c${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name: "Bash", summary: command, ...(ok === undefined ? {} : { ok }) } });
/** Codex-style chip: the command is the name AND the summary. */
const codex = (command: string, ok?: boolean): Message =>
  ({ id: `x${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name: command, summary: command, ...(ok === undefined ? {} : { ok }) } });
/** ACP-style chip: an 80-char title plus the full command in `summary`. */
const acp = (command: string, ok?: boolean): Message =>
  ({ id: `a${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name: command.slice(0, 80), summary: command, ...(ok === undefined ? {} : { ok }) } });
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, role: "bot", kind: "text", text: body });
const stagedSkill = (): Message => ({
  id: `o${++seq}`, at: seq, role: "bot", kind: "options",
  card: { title: "Enable this skill?", options: [], skillRequest: { name: "verify-omb" } } as unknown as Message["card"],
});

const DOCTOR = "pnpm control:omb doctor --url http://127.0.0.1:8799";
const SEND = "node --experimental-strip-types scripts/control-omb.ts send --bot x --text y";
const PRESS = './node_modules/.bin/control-atlas.mjs press "Meta+K"';

describe("parseControlCommand", () => {
  it.each([
    ["pnpm control:omb doctor --url http://127.0.0.1:1", "doctor"],
    ["pnpm run control:omb doctor", "doctor"],
    ["npm run control:omb -- doctor", "doctor"],
    [SEND, "send"],
    [PRESS, "press"],
    ["cd repo && node scripts/control-omb.ts doctor", "doctor"],
    ["node scripts\\control-omb.ts doctor", "doctor"],
    ["FOO=1 pnpm control:omb wait --bot b", "wait"],
    ["timeout 30 npx tsx ./scripts/control-omb.ts screenshot > out.png 2>&1", "screenshot"],
  ])("accepts %s as a control-CLI invocation of %s", (command, subcommand) => {
    expect(parseControlCommand(command)).toEqual({ subcommand, dryRun: false });
  });

  it.each([
    "cat scripts/control-omb.ts",
    "sed -n 1,40p scripts/control-omb.ts",
    "git log -- scripts/control-omb.ts",
    "grep -n doctor scripts/control-omb.ts",
    "cat docs/access-control-omb.tsx",
    "npmcontrol:omb doctor",
    "pnpm typecheck",
    "pnpm typecheck && pnpm test",
  ])("rejects %s — the CLI is not what runs", (command) => {
    expect(parseControlCommand(command)).toBeUndefined();
  });

  it("marks a dry run wherever the flag sits in the segment", () => {
    expect(parseControlCommand("pnpm control:omb send --bot b --dry-run")).toEqual({ subcommand: "send", dryRun: true });
    expect(parseControlCommand("pnpm control:omb --dry-run send")).toEqual({ subcommand: "send", dryRun: true });
    // the flag in another segment belongs to that command
    expect(parseControlCommand("pnpm control:omb doctor && pnpm release --dry-run")).toEqual({ subcommand: "doctor", dryRun: false });
  });

  it("falls back to the CLI token's basename when no subcommand follows", () => {
    expect(parseControlCommand("pnpm control:omb --help")?.subcommand).toBe("control:omb");
    expect(parseControlCommand("./scripts/control-atlas.mjs && echo done")?.subcommand).toBe("control-atlas.mjs");
  });
});

describe("commandOf", () => {
  it("reads the summary and only the summary", () => {
    expect(commandOf(claude(DOCTOR))).toBe(DOCTOR);
    expect(commandOf(codex("ls -la"))).toBe("ls -la");
    expect(commandOf({ ...claude("x"), tool: { name: "Read", ok: true } })).toBeUndefined();
    expect(commandOf(text(DOCTOR))).toBeUndefined();
  });

  it("never reads a chip's name, so a server status chip quoting a command is not a step", () => {
    const stuck: Message = {
      id: "s1", at: 1, role: "bot", kind: "activity",
      tool: { name: `Same call repeated 3× — Bash: ${DOCTOR} — it may be stuck`, ok: false },
    };
    expect(commandOf(stuck)).toBeUndefined();
    expect(verifySteps([stuck])).toEqual([]);
  });
});

describe("nameIsCommand", () => {
  it("tells a command-line title from a bare tool name", () => {
    expect(nameIsCommand("Bash")).toBe(false);
    expect(nameIsCommand("ls -la")).toBe(true);
    expect(nameIsCommand("./scripts/x.mjs")).toBe(true);
  });
});

describe("verifySteps", () => {
  it("lists control-CLI chips from every driver shape, in order, and skips other commands", () => {
    const steps = verifySteps([
      text("Checking the fixture"),
      claude("pnpm typecheck", true),
      claude(DOCTOR, true),
      codex(SEND, false),
      acp(PRESS),
      claude("git status", true),
      claude("cat scripts/control-omb.ts", true),
    ]);
    expect(steps.map((s) => [s.subcommand, s.status])).toEqual([
      ["doctor", "passed"],
      ["send", "failed"],
      ["press", "running"],
    ]);
    expect(steps.map((s) => s.command)).toEqual([DOCTOR, SEND, PRESS]);
  });

  it("maps ok undefined / true / false to running / passed / failed", () => {
    expect(verifySteps([claude(DOCTOR), claude(DOCTOR, true), claude(DOCTOR, false)]).map((s) => s.status))
      .toEqual(["running", "passed", "failed"]);
  });
});

describe("verifySummary", () => {
  it("counts each status and labels only the non-zero counts", () => {
    const steps = verifySteps([claude(DOCTOR, true), claude(DOCTOR, true), codex(SEND, false), acp(PRESS)]);
    expect(verifySummary(steps)).toEqual({ passed: 2, failed: 1, running: 1, dryRuns: 0, label: "2 passed · 1 failed · 1 running" });
    expect(verifySummary(steps.slice(0, 1)).label).toBe("1 passed");
  });

  it("counts a settled dry run as neither passed nor failed", () => {
    const steps = verifySteps([claude(`${DOCTOR} --dry-run`, true), claude(`${SEND} --dry-run`, false), claude(`${PRESS} --dry-run`)]);
    expect(verifySummary(steps)).toEqual({ passed: 0, failed: 0, running: 1, dryRuns: 2, label: "1 running · 2 dry runs" });
    expect(verifySummary(steps.slice(0, 1)).label).toBe("1 dry run");
  });
});

describe("skillStaged", () => {
  it("is true once a skill proposal follows the run's first step", () => {
    const run = [claude(DOCTOR, true), codex(SEND, false)];
    const steps = verifySteps(run);
    expect(skillStaged([text("hi"), ...run], steps)).toBe(false);
    expect(skillStaged([text("hi"), ...run, stagedSkill()], steps)).toBe(true);
    // a proposal from before the run is not this run's
    expect(skillStaged([stagedSkill(), ...run], steps)).toBe(false);
    expect(skillStaged([stagedSkill()], [])).toBe(false);
  });
});

describe("skillPrompt", () => {
  const steps = verifySteps([claude(DOCTOR, true), codex(SEND, false), acp(PRESS), claude(`${DOCTOR} --dry-run`, true)]);
  const prompt = skillPrompt(steps);

  it("mounts the bundled skill by opening with one of its trigger phrases", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../skills/create-verification-skill/manifest.json", import.meta.url), "utf8"));
    const terms: string[] = manifest.triggerTerms;
    const opening = prompt.split("\n")[0].toLowerCase();
    expect(terms.some((term) => opening.includes(term.toLowerCase()))).toBe(true);
  });

  it("states the one rule, then lists every step with its marker — a dry run never as passing", () => {
    expect(prompt).toContain("Do not re-run these steps");
    expect(prompt).toContain(`✓ doctor — ${DOCTOR}`);
    expect(prompt).toContain(`✗ send — ${SEND}`);
    expect(prompt).toContain(`… press — ${PRESS}`);
    expect(prompt).toContain(`[dry run] doctor — ${DOCTOR} --dry-run`);
    expect(prompt).not.toContain(`✓ doctor — ${DOCTOR} --dry-run`);
    // the skill owns the layout; the prompt does not restate it
    expect(prompt).not.toMatch(/Launch \/ Doctor/);
    expect(prompt).not.toContain("skill_manage");
  });
});
