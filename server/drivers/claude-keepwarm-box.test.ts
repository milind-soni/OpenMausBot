// A keep-warm ping and a warm summary where the bot box is on (every Cloud home). Both relaunch Claude Code with the live
// process's MCP config, the bot's own command servers included, and Claude Code starts every listed command as it
// launches, before any tool call and whatever its hooks deny. So a fork runs in a box like the bot's turns: the command
// starts inside it, where the data folder is an empty one. Off a Cloud the box is off and nothing changes.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botBox, type WrappedSpawn } from "../bot-box/box.ts";
import { detectBox } from "../bot-box/detect.ts";
import { visibleInBox } from "../bot-box/plan.ts";
import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { forkSpawnOptions } from "./claude-keepwarm.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const KNOBS = ["FAKE_CLAUDE_PING_DUMP", "FAKE_CLAUDE_COMPACT_DUMP", "FAKE_CLAUDE_STARTS_MCP"] as const;
const TMPDIR = process.env.TMPDIR;

/** A stand-in for bubblewrap with no namespaces: it runs what follows `--`, and what it runs can tell it is inside. */
const MARKING_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
IN_FAKE_BOX=inside; export IN_FAKE_BOX
exec "$@"
`;
/** The bot's own command server: appends where it ran and what it could read of the file it is given to `$0`. */
const SERVER_SCRIPT = 'printf "%s %s\\n" "${IN_FAKE_BOX:-outside}" "$(cat "$1" 2>/dev/null || echo UNREADABLE)" >> "$0"';
const botServer = (marker: string, secret: string) => ({ command: "/bin/sh", args: ["-c", SERVER_SCRIPT, marker, secret], env: {} });
/** The boxed forks so far: the pings (never written down), or the summaries (kept as sessions). */
const boxedForks = (wrap: { mock: { results: Array<{ value: unknown }> } }, kind: "ping" | "summary") =>
  wrap.mock.results.map((result) => result.value as WrappedSpawn | null)
    .filter((spawned): spawned is WrappedSpawn => Boolean(spawned?.args.includes("--fork-session")) && spawned!.args.includes("--no-session-persistence") === (kind === "ping"));

describe("a fork's spawn", () => {
  it("asks for the bot box by name, with its private folder read-only in it", () => {
    const options = forkSpawnOptions({ cwd: "/work/t1" }, { PATH: "/usr/bin" }, "/tmp/omb-keepwarm-x");
    expect(options).toMatchObject({ cwd: "/work/t1", engineHome: true, botWork: true, box: { ro: ["/tmp/omb-keepwarm-x"] } });
  });
});

describe("keep-warm forks in the bot box", () => {
  const dirs: string[] = [];
  let instance: ProviderInstance | null = null;
  afterEach(async () => {
    await instance?.dispose();
    instance = null;
    vi.restoreAllMocks();
    await botBox.stop();
    for (const name of KNOBS) delete process.env[name];
    if (TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = TMPDIR;
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  // The box's gates listen on unix sockets, which Windows refuses at a file path; the box runs only on a Linux Cloud home.
  it.skipIf(process.platform === "win32")("start the bot's own command server inside the box, for a ping and for a summary", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-keepwarm-box-"));
    dirs.push(scratch);
    const fakeBwrap = join(scratch, "fake-bwrap.sh");
    writeFileSync(fakeBwrap, MARKING_BWRAP);
    chmodSync(fakeBwrap, 0o755);
    await botBox.start({
      dataDir: DATA_DIR, home: homedir(), port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: fakeBwrap, socat: "/usr/bin/true" } }),
    });
    const wrap = vi.spyOn(botBox, "wrap");
    // A Cloud has no TMPDIR; here it holds the test's home, and the box puts back the folder TMPDIR names.
    delete process.env.TMPDIR;
    const marker = join(scratch, "started.txt"), pingDump = join(scratch, "ping.json"), compactDump = join(scratch, "compact.json");
    process.env.FAKE_CLAUDE_PING_DUMP = pingDump;
    process.env.FAKE_CLAUDE_COMPACT_DUMP = compactDump;
    process.env.FAKE_CLAUDE_STARTS_MCP = "notes";
    instance = await ClaudeDriver.create({ instanceId: "claude-keepwarm-box", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    const recorder = recordEvents(instance.adapter);
    const cwd = join(DATA_DIR, "task-workspaces", "bot-a", "t-warm-box");
    mkdirSync(cwd, { recursive: true });

    await instance.adapter.sendTurn({
      threadId: "t-warm-box", botId: "bot-a", text: "hi", approvalMode: "full", cwd,
      integrations: { custom: { notes: botServer(marker, join(DATA_DIR, "config.json")) }, customResultBudgets: { notes: 0 } },
    });
    await recorder.until((event) => event.type === "turn.completed", 30_000);
    expect(existsSync(marker), "the fake CLI starts servers only on a fork").toBe(false);

    expect(await instance.adapter.cacheKeepWarm!.ping("t-warm-box")).toMatchObject({ ok: true });
    // The server is still declared, as in the bot's turns: the tool list is part of the cached prefix.
    expect(JSON.parse(readFileSync(pingDump, "utf8")).mcpConfig.mcpServers.notes).toMatchObject({ command: "/bin/sh" });
    expect(readFileSync(marker, "utf8").trim().split("\n").map((line) => line.split(" ")[0]), "the ping started the bot's server in the box").toEqual(["inside"]);

    const ping = boxedForks(wrap, "ping");
    expect(ping, "the ping went through the box").toHaveLength(1);
    const plan = ping[0]!.plan;
    expect(plan.botId).toBe("bot-a");
    expect(plan.net).toBe("isolated");
    for (const hidden of ["messages.db", "config.json", join("workspaces", "bot-b"), join("task-workspaces", "bot-b", "t-other")]) {
      expect(visibleInBox(plan, join(DATA_DIR, hidden)), `${hidden} is not in the ping's box`).toBe("none");
    }
    expect(visibleInBox(plan, cwd)).toBe("rw");
    // The fork's own files: the MCP config and settings on its command line, and the deny hook the settings name.
    const args = ping[0]!.args, mcpConfig = args[args.indexOf("--mcp-config") + 1]!;
    expect(visibleInBox(plan, mcpConfig)).toBe("ro");
    expect(visibleInBox(plan, join(dirname(mcpConfig), "deny-tools.mjs")), "the deny hook can run in the box").toBe("ro");

    expect(await instance.adapter.cacheKeepWarm!.compact!("t-warm-box", { instructions: "" })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(compactDump, "utf8")).mcpConfig.mcpServers.notes).toMatchObject({ command: "/bin/sh" });
    expect(readFileSync(marker, "utf8").trim().split("\n").map((line) => line.split(" ")[0]), "the summary started it in the box too").toEqual(["inside", "inside"]);
    const summary = boxedForks(wrap, "summary");
    expect(summary, "the summary went through the box").toHaveLength(1);
    expect(visibleInBox(summary[0]!.plan, join(DATA_DIR, "config.json"))).toBe("none");
  }, 90_000);

  it.skipIf(process.platform === "win32")("with the box off, a fork runs as it did", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-keepwarm-nobox-"));
    dirs.push(scratch);
    const wrap = vi.spyOn(botBox, "wrap");
    const marker = join(scratch, "started.txt");
    process.env.FAKE_CLAUDE_STARTS_MCP = "notes";
    instance = await ClaudeDriver.create({ instanceId: "claude-keepwarm-nobox", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "t-warm-nobox", botId: "bot-a", text: "hi", approvalMode: "full",
      integrations: { custom: { notes: botServer(marker, join(scratch, "none")) }, customResultBudgets: { notes: 0 } },
    });
    await recorder.until((event) => event.type === "turn.completed", 30_000);
    expect(await instance.adapter.cacheKeepWarm!.ping("t-warm-nobox")).toMatchObject({ ok: true });
    expect(readFileSync(marker, "utf8").trim()).toBe("outside UNREADABLE");
    expect(wrap.mock.results.every((result) => result.value === null)).toBe(true);
  }, 60_000);
});

// The same in a real box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home, the Fly test machine).
const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;

describe.skipIf(!available)(`keep-warm forks in a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  let instance: ProviderInstance | null = null;
  afterEach(async () => {
    await instance?.dispose();
    instance = null;
    await botBox.stop();
    for (const name of KNOBS) delete process.env[name];
    if (TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = TMPDIR;
  });

  it("the bot's command server a ping or a summary starts cannot read the data folder", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    writeFileSync(join(DATA_DIR, "config.json"), "the-server-secret-is-sardine");
    const other = join(DATA_DIR, "workspaces", "bot-b");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "notes.md"), "another-bot-keeps-herring");
    await botBox.start({ dataDir: DATA_DIR, home: homedir(), port: 18799, denyEnv: new Set(), env: { ...process.env, OMB_BOT_BOX: "1" }, log: () => {} });
    expect(botBox.enabled()).toBe(true);
    delete process.env.TMPDIR;
    const cwd = join(DATA_DIR, "task-workspaces", "bot-a", "t-warm-real");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(DATA_DIR, "workspaces", "bot-a"), { recursive: true });
    // The conversation's folder is the one place both the box and the test can reach.
    const marker = join(cwd, "started.txt"), marker2 = join(cwd, "started-b.txt");
    process.env.FAKE_CLAUDE_STARTS_MCP = "notes,herring";
    instance = await ClaudeDriver.create({ instanceId: "claude-keepwarm-real", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "t-warm-real", botId: "bot-a", text: "hi", approvalMode: "full", cwd,
      integrations: {
        custom: { notes: botServer(marker, join(DATA_DIR, "config.json")), herring: botServer(marker2, join(other, "notes.md")) },
        customResultBudgets: { notes: 0, herring: 0 },
      },
    });
    await recorder.until((event) => event.type === "turn.completed", 30_000);

    expect(await instance.adapter.cacheKeepWarm!.ping("t-warm-real")).toMatchObject({ ok: true });
    expect(await instance.adapter.cacheKeepWarm!.compact!("t-warm-real", { instructions: "" })).toMatchObject({ ok: true });
    const started = readFileSync(marker, "utf8"), startedB = readFileSync(marker2, "utf8");
    expect(started.trim().split("\n"), "started by the ping and by the summary").toHaveLength(2);
    expect(started).not.toContain("sardine");
    expect(started).toContain("UNREADABLE");
    expect(startedB).not.toContain("herring");
    expect(startedB).toContain("UNREADABLE");
  }, 120_000);
});
