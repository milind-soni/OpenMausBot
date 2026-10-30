import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import type { ProcessSample } from "../drivers/acp/quiet-status.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { LiveSteps, outputTail, TAIL_FRAME_MS } from "./live-steps.ts";
import type { ProgressEvent } from "./progress-gate.ts";

const NOTICE = 60_000;
let clock = 0;
let offered: ProgressEvent[];
let samples: ProcessSample[];
let sampled: Array<{ pid: number; since: number }>;
let steps: LiveSteps;

const base = (provider: string, extra: Partial<RuntimeEvent> = {}) => ({
  eventId: `e${Math.random()}`, provider, providerInstanceId: provider, threadId: "t1", turnId: "turn-1", createdAt: "2026-10-28T12:00:00.000Z", ...extra,
});
const started = (provider: string, itemId: string, call: { title: string; summary?: string; input?: string }) =>
  ({ ...base(provider, { itemId }), type: "item.started", itemType: "tool", ...call }) as RuntimeEvent;
const bash = (command: string, itemId = "call-1") =>
  started("claudeAgent", itemId, { title: "Bash", summary: commandSummary({ command }), input: toolDetailPreview({ command }) });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
  offered = [];
  samples = [];
  sampled = [];
  steps = new LiveSteps({
    offer: (event) => offered.push(event),
    enginePid: (event) => (event.providerInstanceId === "claudeAgent" ? 4242 : undefined),
    sample: async (pid, since) => {
      sampled.push({ pid, since });
      return samples.shift() ?? { cpuMs: null, connections: null };
    },
    now: () => clock,
    noticeMs: () => NOTICE,
    tickMs: () => 15_000,
  });
});

afterEach(() => {
  steps.stop();
  vi.useRealTimers();
});

const last = () => offered.at(-1)!;

describe("LiveSteps: what the call works on", () => {
  it("stamps the start event with its step and sends the status line's frame for it", () => {
    const event = bash("cd ~/biber && OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz python3 scrape.py --pages 40");
    const stamped = steps.observe(event, false);
    expect(stamped).toMatchObject({ step: { activity: "command", target: "scrape.py" } });
    expect(offered).toEqual([]);
    steps.announce(stamped);
    expect(last()).toMatchObject({ type: "turn.progress", itemId: "call-1", activity: "command", target: "scrape.py", turnId: "turn-1" });
    expect(last().detail).toBe("cd ~/biber && OPENAI_API_KEY=… python3 scrape.py --pages 40");
    expect(JSON.stringify(offered)).not.toContain("sk-proj");
  });

  it("reads Claude, Codex and ACP calls through the same path", () => {
    const codex = "/bin/zsh -lc 'pnpm test'";
    steps.announce(steps.observe(started("codex", "codex-1", { title: codex, summary: commandSummary({ command: codex }), input: toolDetailPreview({ command: codex, cwd: "/w" }) }), false));
    expect(last()).toMatchObject({ provider: "codex", activity: "command", target: "pnpm test" });
    steps.announce(steps.observe(started("acpAgent", "acp-1", { title: "web_fetch", input: toolDetailPreview({ url: "https://www.linkedin.com/in/ada" }) }), false));
    expect(last()).toMatchObject({ provider: "acpAgent", activity: "fetch", target: "linkedin.com" });
    steps.announce(steps.observe(started("claudeAgent", "cl-1", { title: "WebSearch", input: toolDetailPreview({ query: "Biber Dammbau" }) }), false));
    expect(last()).toMatchObject({ activity: "web", target: "Biber Dammbau" });
  });

  it("leaves a call it cannot name as it was", () => {
    const event = started("claudeAgent", "ask-1", { title: "mcp__agents__ask_bot", input: toolDetailPreview({ bot: "Kai" }) });
    expect(steps.observe(event, false)).toBe(event);
    steps.announce(event);
    expect(offered).toEqual([]);
  });

  it("gives an engine's own report about the call the call's words, and leaves other calls' reports alone", () => {
    steps.observe(bash("python3 scrape.py"), false);
    const own = { ...base("claudeAgent", { itemId: "call-1" }), type: "turn.progress", activity: "tool", tool: "Bash", bytes: 40 } as ProgressEvent;
    expect(steps.progress(own)).toMatchObject({ activity: "command", target: "scrape.py", bytes: 40 });
    expect(steps.progress(own).tool).toBeUndefined();
    const other = { ...own, itemId: "call-9" } as ProgressEvent;
    expect(steps.progress(other)).toBe(other);
  });
});

describe("LiveSteps: a long call's sign of life", () => {
  it("says nothing before the quiet notice, then what the call's processes show, once per change", async () => {
    steps.announce(steps.observe(bash("python3 scrape.py"), false));
    offered = [];
    clock += NOTICE - 1;
    await steps.tick();
    expect(sampled).toEqual([]);
    clock += 1;
    samples.push({ cpuMs: 1_000, connections: 1 });
    await steps.tick();
    expect(sampled).toEqual([{ pid: 4242, since: 1_000_000 }]);
    expect(last().quiet).toEqual({ kind: "network" });
    clock += 15_000;
    samples.push({ cpuMs: 9_000, connections: 0 });
    await steps.tick();
    expect(last().quiet).toEqual({ kind: "busy" });
    clock += 15_000;
    samples.push({ cpuMs: 9_050, connections: 0 });
    await steps.tick();
    expect(last().quiet).toEqual({ kind: "idle" });
    const sent = offered.length;
    clock += 15_000;
    samples.push({ cpuMs: 9_060, connections: 0 });
    await steps.tick();
    expect(offered).toHaveLength(sent);
    expect(last()).toMatchObject({ target: "scrape.py", activity: "command" });
  });

  it("does not guess for an engine with no process of its own", async () => {
    steps.announce(steps.observe(started("openaiChat", "x-1", { title: "Bash", summary: "python3 scrape.py", input: "{}" }), false));
    clock += NOTICE;
    await steps.tick();
    expect(sampled).toEqual([]);
    expect(offered.every((frame) => frame.quiet === undefined)).toBe(true);
  });

  it("shows a running command's last lines at most once a second, and its last output once it has run a while", () => {
    steps.announce(steps.observe(bash("pnpm test", "c1"), false));
    const out = (text: string) => steps.output({ ...base("claudeAgent", { itemId: "c1" }), type: "item.output", itemType: "tool", text } as Extract<RuntimeEvent, { type: "item.output" }>);
    out("RUN  v3\n ✓ src/a.test.ts (3)\n");
    expect(last().tail).toEqual(["RUN  v3", "✓ src/a.test.ts (3)"]);
    expect(last().quiet).toBeUndefined();
    const sent = offered.length;
    out(" ✓ src/b.test.ts (5)\n");
    out(" ✓ src/c.test.ts (1)\n");
    expect(offered).toHaveLength(sent);
    clock += TAIL_FRAME_MS;
    vi.advanceTimersByTime(TAIL_FRAME_MS);
    expect(offered).toHaveLength(sent + 1);
    expect(last().tail).toEqual(["✓ src/b.test.ts (5)", "✓ src/c.test.ts (1)"]);
    clock += NOTICE;
    out("export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 done\n");
    expect(last().quiet).toEqual({ kind: "output", at: clock });
    expect(JSON.stringify(last().tail)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("forgets a call when it ends, and everything when its turn ends", async () => {
    steps.announce(steps.observe(bash("python3 scrape.py", "a"), false));
    steps.announce(steps.observe(bash("python3 other.py", "b"), false));
    steps.observe({ ...base("claudeAgent", { itemId: "a" }), type: "item.completed", itemType: "tool", ok: true } as RuntimeEvent, false);
    const own = { ...base("claudeAgent", { itemId: "a" }), type: "turn.progress", activity: "command" } as ProgressEvent;
    expect(steps.progress(own)).toBe(own);
    steps.observe({ ...base("claudeAgent"), type: "turn.completed", ok: true } as RuntimeEvent, true);
    offered = [];
    clock += NOTICE * 2;
    await steps.tick();
    expect(sampled).toEqual([]);
    expect(offered).toEqual([]);
  });
});

describe("outputTail", () => {
  it("keeps the last two lines as printed: no escape codes, a progress bar at its newest state, capped", () => {
    expect(outputTail("\x1b[32mok\x1b[0m one\nfetching 10%\rfetching 55%\rfetching 90%\n\n")).toEqual(["ok one", "fetching 90%"]);
    const [line] = outputTail("x".repeat(500));
    expect(line!.length).toBeLessThanOrEqual(160);
  });

  it("keeps an environment variable's name and never its value, whatever its shape", () => {
    expect(outputTail("PGHOST=db.internal\nexport STRIPE_RESTRICTED=hunter2\n")).toEqual(["PGHOST=…", "export STRIPE_RESTRICTED=…"]);
    expect(outputTail("declare -x HOME=\"/Users/ada\"\n✓ 3 tests passed (x=1)\n")).toEqual(["declare -x HOME=…", "✓ 3 tests passed (x=1)"]);
  });
});
