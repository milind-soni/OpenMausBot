import { describe, expect, it } from "vitest";

import { addServerLinePacks } from "../server-lines.ts";
import { cannotRunCommands, createNoTerminal, modelSwitchNotice, noTerminalPrompt, triedCommand, type TurnReach } from "./no-terminal.ts";

const chatOnCloud: TurnReach = { cloudHome: true, ownShell: false, computerMounted: false, lentTerminal: false };

describe("which turns can't run commands (server/host/no-terminal.ts)", () => {
  it("is a chat-only model on My Cloud with no cloud computer mounted and no lent terminal, and nothing else", () => {
    expect(cannotRunCommands(chatOnCloud)).toBe(true);
    expect(cannotRunCommands({ ...chatOnCloud, ownShell: true }), "an engine with its own shell").toBe(false);
    expect(cannotRunCommands({ ...chatOnCloud, computerMounted: true }), "the cloud computer's exec").toBe(false);
    expect(cannotRunCommands({ ...chatOnCloud, lentTerminal: true }), "a lent computer's terminal").toBe(false);
    expect(cannotRunCommands({ ...chatOnCloud, cloudHome: false }), "the desktop app (Local VM, this computer)").toBe(false);
  });

  it("tells the bot the place, the reason and the ways out, offering the cloud computer only when it is one", () => {
    const text = noTerminalPrompt({ bot: "Ledger", model: "gpt-5-mini", cloudComputer: false, routine: false });
    expect(text).toContain("You cannot run commands this turn. You are on My Cloud, where this model (gpt-5-mini) has no terminal of its own");
    expect(text).toContain("files in your working folder on My Cloud are still there");
    expect(text).toContain("do not give another reason (a missing execution environment, an empty or new computer, lost files)");
    expect(text).toContain("switch Ledger to a model with a terminal, such as Claude or Codex.");
    expect(text).not.toContain("cloud computer, or");
    expect(text).not.toContain("routine run");
    const cloud = noTerminalPrompt({ bot: "Ledger", model: "gpt-5-mini", cloudComputer: true, routine: true });
    expect(cloud).toContain("such as Claude or Codex, or have the work run on the cloud computer.");
    expect(cloud).toContain("This is a routine run: do the parts that need no command, then say plainly which step was not done and why");
  });
});

const REFUSED = "{\"ok\":false,\"result\":\"The requested tool was not advertised for this turn\"}";

describe("the rule for the app's sentence on a routine run", () => {
  it("counts a shell tool, by any of its names, refused because this turn has none, and a refused move off this machine", () => {
    for (const name of ["exec", "bash", "computer_exec", "mcp__computer__exec", "vm_exec", "agents_vm_exec", "run_command", "shell", "python"]) {
      expect(triedCommand({ name, ok: false, output: REFUSED }), name).toBe(true);
    }
    expect(triedCommand({ name: "agents_select_computer", ok: false, input: "{\"surface\":\"cloud\"}" })).toBe(true);
  });
  it("never counts a call that worked, one still running, an app's tool that shares a name and failed for its own reason, or a move to the browser", () => {
    expect(triedCommand({ name: "exec", ok: true, output: "{}" })).toBe(false);
    expect(triedCommand({ name: "exec" })).toBe(false);
    expect(triedCommand({ name: "exec", ok: false, output: "{\"ok\":false,\"result\":\"exit code 1\"}" }), "a shell that ran and failed").toBe(false);
    for (const name of ["agents_list_routines", "gmail.search_emails", "composio_search_tools", "shared_computer", "data_load", "postgres_execute", "x_command"]) {
      expect(triedCommand({ name, ok: false, output: REFUSED }), name).toBe(false);
    }
    expect(triedCommand({ name: "agents_select_computer", ok: false, input: "{\"surface\":\"browser\"}" })).toBe(false);
  });
});

describe("a routine run's line ends with the app's sentence", () => {
  const T0 = 1_000_000;
  function fixture(lines: Array<{ kind: string; at: number; tool?: { name: string; ok?: boolean; output?: string } }>, cloudHome = true) {
    return createNoTerminal({ cloudHome, lines: () => lines });
  }
  const run = { id: "run_1", botId: "b1", threadId: "t1", startedAt: T0, status: "completed" };
  const prompt = { bot: "Ledger", model: "gpt-5-mini", cloudComputer: false, routine: true };
  const reach = { ownShell: false, computerMounted: false, lentTerminal: false };

  it("Case A: a run with no terminal whose bot tried to run its script", () => {
    const host = fixture([{ kind: "text", at: T0 + 1 }, { kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }]);
    expect(host.turn("t1", reach, prompt, T0 + 1)).toContain("You cannot run commands this turn");
    expect(host.runNote(run, undefined)).toBe("Ledger couldn't run commands in this run: gpt-5-mini has no terminal on My Cloud. To let its routines run commands, switch Ledger to a model with a terminal, such as Claude or Codex.");
    const cloud = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }]);
    cloud.turn("t1", reach, { ...prompt, cloudComputer: true }, T0 + 1);
    expect(cloud.runNote(run, undefined)).toMatch(/, or set this routine to run on the Cloud desktop\.$/u);
  });

  it("adds nothing when the bot needed no command, when a turn could run them, off a Cloud home, or for a call before this run", () => {
    const quiet = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "gmail.search_emails", ok: true } }]);
    quiet.turn("t1", reach, prompt, T0 + 1);
    expect(quiet.runNote(run, undefined), "a run that needed no command").toBeNull();
    const shell = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }]);
    expect(shell.turn("t1", { ...reach, ownShell: true }, prompt, T0 + 1)).toBe("");
    expect(shell.runNote(run, undefined), "an engine with its own shell").toBeNull();
    const desktop = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }], false);
    expect(desktop.turn("t1", reach, prompt, T0 + 1)).toBe("");
    expect(desktop.runNote(run, undefined), "the desktop app").toBeNull();
    const earlier = fixture([{ kind: "activity", at: T0 - 5, tool: { name: "exec", ok: false, output: REFUSED } }]);
    earlier.turn("t1", reach, prompt, T0 + 1);
    expect(earlier.runNote(run, undefined), "an earlier run's call in the same conversation").toBeNull();
    const stale = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }]);
    stale.turn("t1", reach, prompt, T0 - 10);
    expect(stale.runNote(run, undefined), "a flag from a turn before this run").toBeNull();
  });

  it("names the model the run's own turn ran on, not one the bot was given after", () => {
    const host = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }]);
    host.turn("t1", reach, { ...prompt, model: "routine-own-model" }, T0 + 1);
    expect(host.runNote(run, undefined)).toContain("routine-own-model has no terminal on My Cloud");
  });

  it("a later turn that can run commands clears it", () => {
    const host = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }]);
    host.turn("t1", reach, prompt, T0 + 1);
    host.turn("t1", { ...reach, computerMounted: true }, prompt, T0 + 3);
    expect(host.runNote(run, undefined)).toBeNull();
  });

  it("hands automation-reports.ts its line through notes, taken once, for the run asked about only", () => {
    const lines = [{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }];
    const runs = new Map([["run_1", run], ["run_2", { threadId: "t2", startedAt: T0 }]]);
    const host = createNoTerminal({ cloudHome: true, lines: () => lines, run: (id) => runs.get(id) });
    host.turn("t1", reach, prompt, T0 + 1);
    expect(host.notes.has("run_2"), "another run's conversation").toBe(false);
    expect(host.notes.has("run_1")).toBe(true);
    expect(host.notes.take("run_1", undefined)).toContain("Ledger couldn't run commands in this run");
    expect(host.notes.has("run_1"), "taken once").toBe(false);
    expect(host.notes.take("run_1", undefined)).toBeNull();
    expect(host.notes.take("run_unknown", undefined)).toBeNull();
  });

  it("reads in the language of the chat it reports to", () => {
    addServerLinePacks({ xx: { "server.reach.runNoTerminal": "{bot} · {model}" } });
    const host = fixture([{ kind: "activity", at: T0 + 2, tool: { name: "exec", ok: false, output: REFUSED } }]);
    host.turn("t1", reach, prompt, T0 + 1);
    expect(host.runNote(run, "xx")).toBe("Ledger · gpt-5-mini");
  });
});

describe("switching a bot to a model with no terminal says so once, only when it matters", () => {
  const base = { cloudHome: true, bot: "Ledger", model: "gpt-5-mini", hadShell: true, hasShell: false, sameEngine: false, ownFolder: false, routines: 0 };
  it("names the routines that will run on the new model", () => {
    expect(modelSwitchNotice({ ...base, routines: 3 }, undefined)).toBe("gpt-5-mini can't run commands on My Cloud by itself. Ledger has 3 routines; they will only be able to do work that needs no commands.");
    expect(modelSwitchNotice({ ...base, routines: 1 }, undefined)).toBe("gpt-5-mini can't run commands on My Cloud by itself. Ledger has a routine; it will only be able to do work that needs no commands.");
    expect(modelSwitchNotice({ ...base, hadShell: false, routines: 2 }, undefined), "from another chat engine, with routines").toContain("Ledger has 2 routines");
  });
  it("says the bot can't run its scripts any more when it leaves a shell or has a folder of its own", () => {
    expect(modelSwitchNotice(base, undefined)).toBe("gpt-5-mini can't run commands on My Cloud by itself, so Ledger can't run scripts or programs here anymore.");
    expect(modelSwitchNotice({ ...base, hadShell: false, ownFolder: true }, undefined)).toContain("can't run scripts or programs here anymore");
  });
  it("says nothing when nothing is lost: a model with a terminal, the desktop app, or chat to chat with nothing to run", () => {
    expect(modelSwitchNotice({ ...base, hasShell: true, routines: 3 }, undefined)).toBeNull();
    expect(modelSwitchNotice({ ...base, cloudHome: false, routines: 3 }, undefined)).toBeNull();
    expect(modelSwitchNotice({ ...base, hadShell: false }, undefined)).toBeNull();
    expect(modelSwitchNotice({ ...base, hadShell: false, sameEngine: true, routines: 3 }, undefined), "another model of the same chat engine").toBeNull();
  });

  it("writes the line in the conversation it was switched from, counting only routines that follow the bot's model", () => {
    const notices: Array<[string, string]> = [];
    const engines: Record<string, { model: string; shell: boolean }> = { claude: { model: "Claude", shell: true }, compat: { model: "gpt-5-mini", shell: false } };
    const host = createNoTerminal({
      cloudHome: true, lines: () => [],
      engine: (selection) => engines[selection.instanceId], bot: () => ({ name: "Ledger" }),
      routines: () => [{ runOn: "maus" }, { runOn: "cloud" }, { runOn: "maus", modelSelection: { instanceId: "claude" } }, {}],
      notice: (threadId, text) => notices.push([threadId, text]),
    });
    host.modelSwitched("b1", "t1", { instanceId: "claude", model: "sonnet" }, { instanceId: "compat", model: "gpt-5-mini" }, true);
    expect(notices).toEqual([["t1", "gpt-5-mini can't run commands on My Cloud by itself. Ledger has 2 routines; they will only be able to do work that needs no commands."]]);
    host.modelSwitched("b1", "t2", { instanceId: "compat", model: "gpt-5-mini" }, { instanceId: "claude", model: "sonnet" }, true);
    host.modelSwitched("b1", "t3", { instanceId: "compat", model: "gpt-5-mini" }, { instanceId: "compat", model: "gpt-5-mini" }, true);
    expect(notices, "back to a terminal, or no change at all").toHaveLength(1);
    host.modelSwitched("b1", "t4", { instanceId: "claude", model: "sonnet" }, { instanceId: "compat", model: "gpt-5-mini" }, false);
    expect(notices[1], "a conversation's own model: its routines keep the bot's").toEqual(["t4", "gpt-5-mini can't run commands on My Cloud by itself, so Ledger can't run scripts or programs here anymore."]);
  });
});
