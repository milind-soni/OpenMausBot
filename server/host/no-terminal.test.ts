import { describe, expect, it } from "vitest";

import { addServerLinePacks } from "../server-lines.ts";
import { createNoTerminal, modelSwitchNotice, triedCommand, type NoTerminalDeps, type TurnReach } from "./no-terminal.ts";

const REFUSED = "{\"ok\":false,\"result\":\"The requested tool was not advertised for this turn\"}";
const T0 = 1_000_000;
const reach: TurnReach = { ownShell: false, computerMounted: false, sharedTools: false, canSelect: false };
type Bot = { desk: boolean };
type Line = { role?: string; kind: string; at: number; text?: string; tool?: { name: string; ok?: boolean; output?: string } };

function host(over: Partial<Omit<NoTerminalDeps<Bot>, "lines">> & { lines?: Line[] } = {}) {
  const { lines = [], ...deps } = over;
  return createNoTerminal<Bot>({ cloudHome: true, lines: () => lines, cloudDesktop: (bot) => bot.desk, ...deps });
}
const noDesk: Bot = { desk: false }, desk: Bot = { desk: true };
const prompt = { model: "gpt-5-mini", routine: false };

describe("a turn's context on My Cloud (server/host/no-terminal.ts)", () => {
  it("a chat-only model with nothing to run commands on is told so, and the ways out are only the true ones", () => {
    const text = host().turn("t1", noDesk, reach, prompt);
    expect(text).toBe(" You can't run commands this turn: on My Cloud this model (gpt-5-mini) has no terminal of its own, and no cloud desktop is in use. Nothing is broken."
      + " If the work needs a command, don't try another way or give another reason: say gpt-5-mini can't run commands on My Cloud, and that a model with a terminal, such as Claude or Codex can.");
    expect(host().turn("t1", desk, reach, prompt)).toContain("such as Claude or Codex, or the cloud desktop, can.");
    expect(host().turn("t1", noDesk, reach, { ...prompt, routine: true })).toMatch(/Do the parts that need no command and say which step was not done, without giving a reason for it\.$/u);
  });

  it("must-fix 1: a turn that may move, with the cloud desktop open to this bot, is told to select it, never not to look for another way", () => {
    const text = host().turn("t1", desk, { ...reach, canSelect: true }, prompt);
    expect(text).toBe(" This turn has no terminal: on My Cloud this model (gpt-5-mini) can't run commands itself. To run one, call select_computer with surface \"cloud\": the request moves to the cloud desktop, where exec runs it.");
    expect(text).not.toContain("another way");
    // Computer access Off, a tool scope or policy that leaves it out, or none set up: no way out but a model, and it says so.
    expect(host().turn("t1", noDesk, { ...reach, canSelect: true }, prompt)).toContain("don't try another way");
  });

  it("says nothing where commands can run, or where a lent computer's terminal is the computer's to explain, or off My Cloud", () => {
    expect(host().turn("t1", desk, { ...reach, ownShell: true }, prompt)).toBe("");
    expect(host().turn("t1", desk, { ...reach, computerMounted: true }, prompt)).toBe("");
    // A lent computer that lends its terminal, online or not: when it is off, that is the reason, and the bot may say it.
    expect(host({ lentTerminal: () => true }).turn("t1", noDesk, { ...reach, sharedTools: true }, prompt)).toBe("");
    expect(host({ lentTerminal: () => false }).turn("t1", noDesk, { ...reach, sharedTools: true }, prompt)).toContain("You can't run commands");
    expect(host({ cloudHome: false }).turn("t1", noDesk, reach, prompt), "a team's Cloud and the desktop app").toBe("");
  });
});

describe("the rule for the app's sentence on a routine run", () => {
  it("is a shell tool, by any of its names, refused because this turn has none", () => {
    for (const name of ["exec", "bash", "computer_exec", "mcp__computer__exec", "vm_exec", "agents_vm_exec", "run_command", "shell", "python"]) {
      expect(triedCommand({ name, ok: false, output: REFUSED }), name).toBe(true);
    }
  });
  it("never a call that worked, one still running, a command that ran and failed, an app's tool that shares a name, or select_computer", () => {
    expect(triedCommand({ name: "exec", ok: true, output: "{}" })).toBe(false);
    expect(triedCommand({ name: "exec" })).toBe(false);
    expect(triedCommand({ name: "exec", ok: false, output: "{\"ok\":false,\"result\":\"exit code 1\"}" })).toBe(false);
    for (const name of ["agents_list_routines", "gmail.search_emails", "shared_computer", "postgres_execute", "x_command", "agents_select_computer"]) {
      expect(triedCommand({ name, ok: false, output: REFUSED }), name).toBe(false);
    }
  });
});

describe("a routine run's line ends with the app's sentence", () => {
  const refused: Line = { kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } };
  const said = (text: string): Line => ({ role: "bot", kind: "text", at: T0 + 3, text });
  const runOf = (status = "completed", routineId = "r1") => ({ routineId, threadId: "t1", startedAt: T0, status });
  const SENTENCE = "This run couldn't run commands: gpt-5-mini has no terminal on My Cloud. To run them, this routine needs a model with a terminal, such as Claude or Codex.";

  it("Case A: a run with no terminal whose bot tried its script, under its reply; and under the line saying it failed", () => {
    const one = host({ lines: [refused, said("No execution environment was mounted.")], run: () => runOf() });
    one.turn("t1", noDesk, reach, { ...prompt, routine: true }, T0 + 1);
    expect(one.notes.has("run")).toBe(false);
    expect(one.notes.take("run", undefined)).toBe(SENTENCE);
    const failed = host({ lines: [refused], run: () => runOf("failed") });
    failed.turn("t1", desk, reach, { ...prompt, routine: true }, T0 + 1);
    expect(failed.notes.take("run", undefined)).toBe(SENTENCE.replace("Claude or Codex.", "Claude or Codex, or to run on the cloud desktop."));
  });

  it("says it once per routine and model, never makes a line by itself, and never for a quiet run", () => {
    const lines = [refused, said("Couldn't run sync.py.")];
    let run = runOf();
    const h = host({ lines, run: () => run });
    h.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(h.notes.take("run", undefined)).toBe(SENTENCE);
    h.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(h.notes.take("run", undefined), "the same routine on the same model again").toBeNull();
    h.turn("t1", noDesk, reach, { ...prompt, model: "other-model" }, T0 + 1);
    expect(h.notes.take("run", undefined), "on another model").toContain("other-model has no terminal");
    run = runOf("completed", "r2");
    const quiet = host({ lines: [refused, said("Checked.\nNOTHING NEW")], run: () => run });
    quiet.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(quiet.notes.has("run")).toBe(false);
    expect(quiet.notes.take("run", undefined), "a quiet run").toBeNull();
    const silent = host({ lines: [refused], run: () => run });
    silent.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(silent.notes.take("run", undefined), "a run that said nothing").toBeNull();
  });

  it("names the model the run's own turn ran on, and asks for a model, never for the bot's to change (a routine can have its own)", () => {
    const h = host({ lines: [refused, said("Couldn't.")], run: () => runOf() });
    h.turn("t1", noDesk, reach, { ...prompt, model: "routine-own-model" }, T0 + 1);
    const text = h.notes.take("run", undefined)!;
    expect(text).toContain("routine-own-model has no terminal on My Cloud");
    expect(text).not.toMatch(/switch/iu);
  });

  it("adds nothing when no command was tried, a turn could run them, the call came before this run, or off My Cloud", () => {
    const tried = [refused, said("Done.")];
    const none = host({ lines: [said("Filed.")], run: () => runOf() });
    none.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(none.notes.take("run", undefined)).toBeNull();
    const shell = host({ lines: tried, run: () => runOf() });
    shell.turn("t1", noDesk, { ...reach, ownShell: true }, prompt, T0 + 1);
    expect(shell.notes.take("run", undefined)).toBeNull();
    const before = host({ lines: [{ ...refused, at: T0 - 5 }, said("Done.")], run: () => runOf() });
    before.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(before.notes.take("run", undefined)).toBeNull();
    const stale = host({ lines: tried, run: () => runOf() });
    stale.turn("t1", noDesk, reach, prompt, T0 - 10);
    expect(stale.notes.take("run", undefined)).toBeNull();
    const desktop = host({ cloudHome: false, lines: tried, run: () => runOf() });
    desktop.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(desktop.notes.take("run", undefined)).toBeNull();
  });

  it("reads in the language of the chat it reports to", () => {
    addServerLinePacks({ xx: { "server.reach.runNoTerminal": "· {model}" } });
    const h = host({ lines: [refused, said("Couldn't.")], run: () => runOf() });
    h.turn("t1", noDesk, reach, prompt, T0 + 1);
    expect(h.notes.take("run", "xx")).toBe("· gpt-5-mini");
  });
});

describe("switching a bot to a model with no terminal says so once, only where it is true", () => {
  const engines: Record<string, { model: string; shell: boolean }> = { claude: { model: "Claude", shell: true }, compat: { model: "gpt-5-mini", shell: false } };
  function switcher(over: Partial<Omit<NoTerminalDeps<Bot>, "lines">> = {}) {
    const notices: Array<[string, string]> = [];
    const h = host({
      engine: (selection) => engines[selection.instanceId], bot: () => ({ name: "Ledger" }), noComputer: () => true, lentTerminal: () => false,
      routines: () => [{ runOn: "maus" }, { runOn: "cloud" }, { runOn: "maus", modelSelection: { instanceId: "claude" } }, {}],
      notice: (threadId, text) => notices.push([threadId, text]), ...over,
    });
    return { h, notices };
  }
  const claude = { instanceId: "claude", model: "sonnet" }, compat = { instanceId: "compat", model: "gpt-5-mini" };

  it("names the routines that follow the bot's model and lose commands, in the conversation it was switched from", () => {
    const { h, notices } = switcher();
    h.modelSwitched("b1", "t1", claude, compat, true);
    expect(notices).toEqual([["t1", "gpt-5-mini can't run commands on My Cloud by itself. Ledger has 2 routines; they will only be able to do work that needs no commands."]]);
    h.modelSwitched("b1", "t2", compat, claude, true);
    h.modelSwitched("b1", "t3", compat, compat, true);
    expect(notices, "back to a terminal, or no change").toHaveLength(1);
  });

  it("must-fix 2: says nothing where the bot's work still has a computer that runs commands", () => {
    // Works on the cloud desktop, a VPS on Auto, a team's computer, a chat pinned to the cloud desktop (turnSurfacePlan).
    for (const noComputer of [() => false, (_botId: string, threadId?: string) => threadId === undefined]) {
      const { h, notices } = switcher({ noComputer });
      h.modelSwitched("b1", "t1", claude, compat, true);
      expect(notices).toEqual([]);
    }
    // A lent computer that lends its terminal.
    const lent = switcher({ lentTerminal: () => true });
    lent.h.modelSwitched("b1", "t1", claude, compat, true);
    expect(lent.notices).toEqual([]);
  });

  it("a conversation's own model reads as this chat only, and counts no routines", () => {
    const { h, notices } = switcher();
    h.modelSwitched("b1", "t4", claude, compat, false);
    expect(notices).toEqual([["t4", "In this chat, gpt-5-mini can't run commands on My Cloud by itself, so scripts and programs can't run here."]]);
  });

  it("says nothing when nothing is lost", () => {
    const base = { bot: "Ledger", model: "gpt-5-mini", hadShell: true, sameEngine: false, ownFolder: false, routines: 0, chatOnly: false };
    expect(modelSwitchNotice(base, undefined)).toBe("gpt-5-mini can't run commands on My Cloud by itself, so Ledger can't run scripts or programs here anymore.");
    expect(modelSwitchNotice({ ...base, hadShell: false }, undefined), "chat to chat with nothing to run").toBeNull();
    expect(modelSwitchNotice({ ...base, hadShell: false, sameEngine: true, routines: 3 }, undefined), "another model of the same chat engine").toBeNull();
    expect(modelSwitchNotice({ ...base, routines: 1 }, undefined)).toContain("Ledger has a routine; it will only");
    const desktop = switcher({ cloudHome: false });
    desktop.h.modelSwitched("b1", "t1", claude, compat, true);
    expect(desktop.notices).toEqual([]);
  });
});
