import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SAVE_RUN_AS_SKILL_LINE } from "../../shared/learn-request";
import {
  askText,
  commandOf,
  nameIsCommand,
  parseControlCommand,
  parseRunCommand,
  runSteps,
  runSummary,
  showRun,
  skillPrompt,
  skillStaged,
  verifySteps,
  verifySummary,
} from "./verify-steps";
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
/** What the person typed: the message that opens an ask. */
const ask = (body: string): Message => ({ id: `u${++seq}`, at: seq, role: "user", kind: "text", text: body });
const stagedSkill = (): Message => ({
  id: `o${++seq}`, at: seq, role: "bot", kind: "options",
  card: { title: "Enable this skill?", options: [], skillRequest: { name: "verify-omb" } } as unknown as Message["card"],
});
const triggerTerms = (): string[] =>
  JSON.parse(readFileSync(new URL("../../skills/create-verification-skill/manifest.json", import.meta.url), "utf8")).triggerTerms;

const DOCTOR = "pnpm control:omb doctor --url http://127.0.0.1:8799";
const SEND = "node --experimental-strip-types scripts/control-omb.ts send --bot x --text y";
const PRESS = './node_modules/.bin/control-atlas.mjs press "Meta+K"';
const PUSH = "git push origin main";

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
    ["sudo -u maus pnpm control:omb doctor", "doctor"],
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

describe("parseRunCommand", () => {
  it.each([
    "cat scripts/x.ts",
    "git log --oneline",
    "git -C repo status --short",
    "gh pr view 12",
    "gh api repos/o/r/pulls/1",
    "grep -rn foo src",
    "sed -n 1,5p f",
    "curl https://x",
    "curl -sSL https://x",
    "ls -la | grep foo",
    "head -n 20 f; tail -n 5 f",
    "cd repo",
    "FOO=1",
    "export FOO=bar",
    "echo done > out.txt",
  ])("%s is not a step — it only looks", (command) => {
    expect(parseRunCommand(command)).toBeUndefined();
  });

  it.each([
    [PUSH, "git push"],
    ["git -C repo commit -m x", "git commit"],
    ["gh release create v1 --notes x", "gh release"],
    ["gh api -X POST repos/o/r/issues -f title=x", "gh api"],
    ["gh api --method DELETE repos/o/r/issues/1", "gh api"],
    ["npm publish", "npm publish"],
    ["pnpm typecheck", "pnpm typecheck"],
    ["pnpm run build", "pnpm build"],
    ["sed -i 's/a/b/' f", "sed"],
    ["curl -X POST https://x -d '{}'", "curl"],
    ["curl -o out.zip https://x", "curl"],
    ["wget --post-data a=b https://x", "wget"],
    ["docker compose up -d", "docker compose"],
    ["kubectl apply -f k.yaml", "kubectl apply"],
    ["npx tsx scripts/x.ts", "npx"],
    ["./node_modules/.bin/vitest run", "vitest"],
    ["FOO=1 timeout 30 git push", "git push"],
    ["sudo -u maus systemctl restart omb", "systemctl"],
  ])("%s is a step labelled %s", (command, label) => {
    expect(parseRunCommand(command)).toEqual({ label, verified: false, dryRun: false });
  });

  it("includes a compound command once, named by the segment that did work", () => {
    expect(parseRunCommand("cat a && npm publish")).toEqual({ label: "npm publish", verified: false, dryRun: false });
    expect(parseRunCommand("cd repo && git status && git push")).toEqual({ label: "git push", verified: false, dryRun: false });
    expect(parseRunCommand("npm publish | tee out.log")).toEqual({ label: "npm publish", verified: false, dryRun: false });
  });

  it("marks a control-CLI segment verified, labelled by its subcommand", () => {
    expect(parseRunCommand(DOCTOR)).toEqual({ label: "doctor", verified: true, dryRun: false });
    expect(parseRunCommand(`git status && ${SEND}`)).toEqual({ label: "send", verified: true, dryRun: false });
    expect(parseRunCommand(`${DOCTOR} --dry-run`)).toEqual({ label: "doctor", verified: true, dryRun: true });
  });

  it("marks an unverified dry run too", () => {
    expect(parseRunCommand("npm publish --dry-run")).toEqual({ label: "npm publish", verified: false, dryRun: true });
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
    expect(runSteps([stuck])).toEqual([]);
  });
});

describe("nameIsCommand", () => {
  it("tells a command-line title from a bare tool name", () => {
    expect(nameIsCommand("Bash")).toBe(false);
    expect(nameIsCommand("ls -la")).toBe(true);
    expect(nameIsCommand("./scripts/x.mjs")).toBe(true);
  });
});

describe("runSteps", () => {
  it("lists every command from every driver shape, in order, reads left out, control-CLI steps verified", () => {
    const steps = runSteps([
      ask("verify the fixture"),
      text("Checking the fixture"),
      claude("pnpm typecheck", true),
      claude(DOCTOR, true),
      codex(SEND, false),
      acp(PRESS),
      claude("git status", true),
      claude("cat scripts/control-omb.ts", true),
      claude(PUSH, true),
    ]);
    expect(steps.map((s) => [s.label, s.status, s.verified])).toEqual([
      ["pnpm typecheck", "passed", false],
      ["doctor", "passed", true],
      ["send", "failed", true],
      ["press", "running", true],
      ["git push", "passed", false],
    ]);
    expect(steps.map((s) => s.command)).toEqual(["pnpm typecheck", DOCTOR, SEND, PRESS, PUSH]);
  });

  it("maps ok undefined / true / false to running / passed / failed", () => {
    expect(runSteps([claude(DOCTOR), claude(DOCTOR, true), claude(DOCTOR, false)]).map((s) => s.status))
      .toEqual(["running", "passed", "failed"]);
  });

  it("starts at the person's last message, so a previous ask's steps drop off", () => {
    const steps = runSteps([ask("release it"), claude("npm publish", true), ask("now verify"), claude(DOCTOR, true), claude(PUSH, true)]);
    expect(steps.map((s) => s.label)).toEqual(["doctor", "git push"]);
    // a blank user message (an attachment-only send) does not open an ask
    expect(runSteps([ask("release it"), claude("npm publish", true), ask("  "), claude(DOCTOR, true)]).map((s) => s.label))
      .toEqual(["npm publish", "doctor"]);
    // the bot's own text is not an ask
    expect(runSteps([ask("release it"), claude("npm publish", true), text("done"), claude(DOCTOR, true)]).map((s) => s.label))
      .toEqual(["npm publish", "doctor"]);
    // no ask at all (a routine's thread): the thread is one run
    expect(runSteps([claude("npm publish", true), claude(DOCTOR, true)]).map((s) => s.label)).toEqual(["npm publish", "doctor"]);
  });

  it("keeps its old names for one release", () => {
    expect(verifySteps).toBe(runSteps);
    expect(verifySummary).toBe(runSummary);
  });
});

describe("askText", () => {
  it("is the first line of the person's last message, trimmed and capped at 300 characters", () => {
    expect(askText([ask("  verify the fixture  \nthen push"), claude(DOCTOR, true)])).toBe("verify the fixture");
    expect(askText([ask("first"), claude(DOCTOR, true), ask("second"), claude(DOCTOR, true)])).toBe("second");
    expect(askText([ask("first"), text("the bot's reply is not the ask")])).toBe("first");
    expect(askText([ask("x".repeat(400))])).toHaveLength(300);
  });

  it("is undefined when the person has not said anything", () => {
    expect(askText([claude(DOCTOR, true)])).toBeUndefined();
    expect(askText([ask("   ")])).toBeUndefined();
    expect(askText([])).toBeUndefined();
  });
});

describe("showRun", () => {
  it("shows a run with a verified step, or with two or more steps — one unverified command is a chip, not a run", () => {
    const [push, publish] = runSteps([claude(PUSH, true), claude("npm publish", true)]);
    const [doctor] = runSteps([claude(DOCTOR, true)]);
    expect(showRun([])).toBe(false);
    expect(showRun([push])).toBe(false);
    expect(showRun([push, publish])).toBe(true);
    expect(showRun([doctor])).toBe(true);
  });
});

describe("runSummary", () => {
  it("counts the steps first, then only the non-zero verified, failed and running counts", () => {
    const steps = runSteps([claude(DOCTOR, true), claude(DOCTOR, true), codex(SEND, false), acp(PRESS), claude(PUSH, true)]);
    expect(runSummary(steps)).toEqual({
      total: 5, verified: 4, passed: 3, failed: 1, running: 1, dryRuns: 0, label: "5 steps · 4 verified · 1 failed · 1 running",
    });
    expect(runSummary(steps.slice(0, 1)).label).toBe("1 step · 1 verified");
    expect(runSummary(steps.slice(4)).label).toBe("1 step");
    expect(runSummary(runSteps([claude(PUSH, true), claude("npm publish", false)])).label).toBe("2 steps · 1 failed");
  });

  it("counts a settled dry run as neither passed nor failed", () => {
    const steps = runSteps([claude(`${DOCTOR} --dry-run`, true), claude(`${SEND} --dry-run`, false), claude(`${PRESS} --dry-run`)]);
    expect(runSummary(steps)).toEqual({
      total: 3, verified: 3, passed: 0, failed: 0, running: 1, dryRuns: 2, label: "3 steps · 3 verified · 1 running · 2 dry runs",
    });
    expect(runSummary(steps.slice(0, 1)).label).toBe("1 step · 1 verified · 1 dry run");
  });
});

describe("skillStaged", () => {
  it("is true once a skill proposal follows the run's first step", () => {
    const run = [claude(DOCTOR, true), codex(SEND, false)];
    const steps = runSteps(run);
    expect(skillStaged([text("hi"), ...run], steps)).toBe(false);
    expect(skillStaged([text("hi"), ...run, stagedSkill()], steps)).toBe(true);
    // a proposal from before the run is not this run's
    expect(skillStaged([stagedSkill(), ...run], steps)).toBe(false);
    expect(skillStaged([stagedSkill()], [])).toBe(false);
  });
});

describe("skillPrompt", () => {
  describe("for a run with a verified step", () => {
    const steps = runSteps([claude(DOCTOR, true), codex(SEND, false), acp(PRESS), claude(`${DOCTOR} --dry-run`, true), claude(PUSH, true)]);
    const prompt = skillPrompt(steps, "verify the fixture");

    it("mounts the bundled skill by opening with one of its trigger phrases", () => {
      const terms = triggerTerms();
      const opening = prompt.split("\n")[0].toLowerCase();
      expect(terms.some((term) => opening.includes(term.toLowerCase()))).toBe(true);
      // the skill mounts on a substring match anywhere in the turn
      // (selectBundledSkills), so notes typed above or below still mount it
      const annotated = `Also cover the send step.\n\n${prompt}Keep the doctor step first.`.toLowerCase();
      expect(terms.some((term) => annotated.includes(term.toLowerCase()))).toBe(true);
    });

    it("carries the person's request as the goal, between the trigger line and the rule", () => {
      expect(prompt.split("\n").slice(0, 4)).toEqual([
        "Create a verification skill from the run below.",
        "Goal: verify the fixture",
        "Do not re-run these steps; their results are in this thread. Use the passing ones as the recipe with their exact commands and note the failed ones as gotchas.",
        "",
      ]);
      // no request known: no Goal line, nothing invented
      const bare = skillPrompt(steps);
      expect(bare.split("\n")[1]).toMatch(/^Do not re-run these steps/);
      expect(bare).not.toContain("Goal:");
    });

    it("ends with a blank line so the caret lands below the steps in the composer", () => {
      expect(prompt.endsWith(`✓ git push — ${PUSH}\n\n`)).toBe(true);
      expect(prompt.endsWith("\n\n\n")).toBe(false);
    });

    it("lists every step with its marker, the verified ones tagged — a dry run never as passing", () => {
      expect(prompt).toContain(`✓ doctor — ${DOCTOR} (verified)\n`);
      expect(prompt).toContain(`✗ send — ${SEND} (verified)\n`);
      expect(prompt).toContain(`… press — ${PRESS} (verified)\n`);
      expect(prompt).toContain(`[dry run] doctor — ${DOCTOR} --dry-run (verified)\n`);
      expect(prompt).toContain(`✓ git push — ${PUSH}\n`);
      expect(prompt).not.toContain(`${PUSH} (verified)`);
      expect(prompt).not.toContain(`✓ doctor — ${DOCTOR} --dry-run`);
      // the skill owns the layout; the prompt does not restate it
      expect(prompt).not.toMatch(/Launch \/ Doctor/);
      expect(prompt).not.toContain("skill_manage");
    });
  });

  describe("for a run with no verified step", () => {
    const steps = runSteps([claude(PUSH, true), claude("npm publish", false), claude("gh release create v1")]);
    const prompt = skillPrompt(steps, "publish the release");

    // server/skill-learn.test.ts proves the other half: a turn that opens with
    // this line is expanded into the skill-authoring turn exactly as /learn is.
    it("asks in plain words — no slash command — with the goal and the one rule under the shared opening line", () => {
      expect(prompt.startsWith(`${SAVE_RUN_AS_SKILL_LINE}\n`)).toBe(true);
      expect(prompt.split("\n").slice(0, 4)).toEqual([
        SAVE_RUN_AS_SKILL_LINE,
        "Goal: publish the release",
        "Keep the exact commands and note the failed ones as gotchas. Do not re-run anything.",
        "",
      ]);
      expect(prompt).not.toContain("/learn");
      // no request known: the run itself is the goal
      expect(skillPrompt(steps).split("\n")[1]).toBe("Goal: the run below");
    });

    it("does not carry the verification-skill trigger phrase, so that skill stays unmounted", () => {
      const lower = prompt.toLowerCase();
      expect(triggerTerms().some((term) => lower.includes(term.toLowerCase()))).toBe(false);
    });

    it("lists the steps untagged and ends with a blank line", () => {
      expect(prompt).toContain(`✓ git push — ${PUSH}\n`);
      expect(prompt).toContain("✗ npm publish — npm publish\n");
      expect(prompt).toContain("… gh release — gh release create v1\n");
      expect(prompt).not.toContain("(verified)");
      expect(prompt.endsWith("… gh release — gh release create v1\n\n")).toBe(true);
    });
  });
});
