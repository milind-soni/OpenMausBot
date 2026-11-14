import { describe, expect, it } from "vitest";

import { EXIT, HEADLESS_VERBS, MUTATING_VERBS, oneOf, parseCommand, parseCount, parseDuration, parseSize } from "./args.ts";

const usage = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return { message: (error as Error).message, exitCode: (error as { exitCode?: number }).exitCode };
  }
  throw new Error("expected a usage error");
};

describe("parseCommand", () => {
  it("reads a verb's flags and values, with control-omb's flag forms", () => {
    expect(parseCommand(["run", "Room Lead", "Rehearse the launch", "--wait", "job", "--timeout", "30m", "--json"])).toEqual({
      verb: "run", positionals: ["Room Lead", "Rehearse the launch"], flags: { wait: "job", timeout: "30m", json: true },
    });
    expect(parseCommand(["wait", "--bot", "b1", "--task", "t1", "--timeout", "30"])).toMatchObject({ verb: "wait", flags: { bot: "b1", task: "t1", timeout: "30" } });
    expect(parseCommand(["send", "Mira", "-"])).toMatchObject({ positionals: ["Mira", "-"] });
    expect(parseCommand(["events", "--thread", "a", "--thread", "b"]).flags.thread).toEqual(["a", "b"]);
    expect(parseCommand(["send", "Mira", "--", "--not-a-flag"]).positionals).toEqual(["Mira", "--not-a-flag"]);
  });

  it("names team and engine actions as one verb", () => {
    expect(parseCommand(["team", "apply", "room.yaml", "--check"])).toMatchObject({ verb: "team apply", positionals: ["room.yaml"], flags: { check: true } });
    expect(parseCommand(["team", "export", "--team", "A", "--team", "B", "--out", "t.yaml"]).flags).toMatchObject({ team: ["A", "B"], out: "t.yaml" });
    expect(parseCommand(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY"])).toMatchObject({ verb: "engine set", positionals: ["claude"] });
    expect(parseCommand(["engine", "list"]).verb).toBe("engine list");
    expect(usage(() => parseCommand(["team", "destroy"]))).toEqual({ message: "team needs one of: apply, export", exitCode: EXIT.usage });
  });

  it("refuses unknown verbs and flags, missing values and extra values, as usage errors (exit 2)", () => {
    expect(usage(() => parseCommand(["dance"]))).toMatchObject({ message: 'unknown verb "dance"', exitCode: 2 });
    expect(usage(() => parseCommand(["run", "Mira", "x", "--colour", "blue"]))).toMatchObject({ exitCode: 2, message: expect.stringContaining("--colour") });
    expect(usage(() => parseCommand(["send", "Mira", "--text"]))).toMatchObject({ exitCode: 2 });
    expect(usage(() => parseCommand(["send", "Mira", "hello", "there"]))).toMatchObject({ exitCode: 2, message: expect.stringContaining("in quotes") });
    // there is deliberately no --token: a command line leaks
    expect(usage(() => parseCommand(["doctor", "--token", "omb_sess_x"]))).toMatchObject({ exitCode: 2 });
  });

  it("knows which verbs change something", () => {
    for (const verb of ["send", "run", "interrupt", "team apply", "engine set", "token create", "token revoke"]) expect(MUTATING_VERBS.has(verb), verb).toBe(true);
    for (const verb of ["doctor", "bots", "wait", "messages", "export", "events", "team export", "engine list"]) expect(MUTATING_VERBS.has(verb), verb).toBe(false);
    expect([...HEADLESS_VERBS].sort()).toEqual(["bots", "channels", "connect", "doctor", "edit", "engine", "events", "export", "interrupt", "mcp",
      "messages", "models", "new-bot", "new-channel", "run", "send", "send-channel", "set-model", "team", "token", "wait"]);
  });
});

describe("durations, sizes, counts and choices", () => {
  it("reads 90, 90s, 5m, 2h and bounds them", () => {
    expect(parseDuration("90", "--timeout")).toBe(90_000);
    expect(parseDuration("90s", "--timeout")).toBe(90_000);
    expect(parseDuration("5m", "--timeout")).toBe(300_000);
    expect(parseDuration("2h", "--timeout")).toBe(7_200_000);
    expect(parseDuration("0", "--wait-idle", { min: 0 })).toBe(0);
    for (const bad of ["0", "25h", "soon", "-5", "5d"]) expect(usage(() => parseDuration(bad, "--timeout")).message).toBe("--timeout must be a duration from 1s to 24h, such as 90, 90s, 5m or 2h");
    expect(parseDuration("90d", "--expires", { max: 3_650 * 86_400_000 })).toBe(90 * 86_400_000);
    expect(usage(() => parseDuration("30m", "--expires", { min: 3_600_000, max: 3_650 * 86_400_000 })).message)
      .toBe("--expires must be a duration from 1h to 3650d, such as 12h, 30d or 90d");
  });

  it("reads sizes, counts and one-of choices", () => {
    expect(parseSize("500MB", "--max-bytes")).toBe(500_000_000);
    expect(parseSize("2gb", "--max-bytes")).toBe(2_000_000_000);
    expect(parseSize("1048576", "--max-bytes")).toBe(1_048_576);
    expect(usage(() => parseSize("lots", "--max-bytes")).exitCode).toBe(2);
    expect(parseCount(undefined, "--limit", 30, 200)).toBe(30);
    expect(parseCount("0", "--max-files", 200, 1_000, 0)).toBe(0);
    expect(usage(() => parseCount("201", "--limit", 30, 200)).message).toBe("--limit must be a whole number from 1 to 200");
    expect(oneOf(undefined, "--wait", ["job", "turn", "none"] as const, "job")).toBe("job");
    expect(usage(() => oneOf("later", "--wait", ["job", "turn", "none"] as const, "job")).message).toBe("--wait must be one of: job, turn, none");
  });
});
