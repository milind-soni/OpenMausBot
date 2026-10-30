// A Claude turn where the bot box is on (every Cloud home): the engine and the helpers it starts see only what the box puts
// back, and the data folder is empty in there. The question tool's helper reaches the broker through a socket the driver
// makes in the data folder, so the box must put that socket back. Off a Cloud the box is off and nothing changes.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botBox, type WrappedSpawn } from "../bot-box/box.ts";
import { visibleInBox } from "../bot-box/plan.ts";
import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const KNOBS = ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_TOOL_CALLS", "FAKE_CLAUDE_MODE"] as const;
const TMPDIR = process.env.TMPDIR;

describe("a Claude turn in the bot box", () => {
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
  it.skipIf(process.platform === "win32")("puts the turn's permission socket in the box, so the bot's question reaches the person", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-claude-box-"));
    dirs.push(scratch);
    // A stand-in for bubblewrap: no namespaces, it runs what follows `--`; the plan it was given is what the test reads.
    const fakeBwrap = join(scratch, "fake-bwrap.sh");
    writeFileSync(fakeBwrap, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n`);
    chmodSync(fakeBwrap, 0o755);
    await botBox.start({
      dataDir: DATA_DIR, home: homedir(), port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      // /usr/bin/true stands in for socat: the shell init starts it, waits once, and execs the engine.
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: fakeBwrap, socat: "/usr/bin/true" } }),
    });
    const wrap = vi.spyOn(botBox, "wrap");
    // A Cloud has no TMPDIR; here it holds the test's home, and the box puts back the folder TMPDIR names.
    delete process.env.TMPDIR;
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify([{ name: "ask_user", server: "ogb", input: { question: "Which account?" } }]);
    instance = await ClaudeDriver.create({ instanceId: "claude-box", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    const recorder = recordEvents(instance.adapter);
    const cwd = join(DATA_DIR, "task-workspaces", "bot-a", "t-boxed-ask");
    mkdirSync(cwd, { recursive: true });

    await instance.adapter.sendTurn({ threadId: "t-boxed-ask", botId: "bot-a", text: "Pick the account", approvalMode: "full", cwd });
    const opened = await recorder.until((event) => event.type === "request.opened", 30_000) as { requestId: string; requestType: string };
    expect(opened.requestType).toBe("question");
    expect(await instance.adapter.respondToRequest("t-boxed-ask", opened.requestId, { behavior: "answer", message: "Work" })).toBe("answered");
    await recorder.until((event) => event.type === "turn.completed", 30_000);

    const boxed = wrap.mock.results.map((result) => result.value as WrappedSpawn | null).find((spawned) => spawned?.plan.botId === "bot-a");
    expect(boxed, "the engine ran in the box").toBeTruthy();
    const socket = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.ogb.args[1] as string;
    expect(visibleInBox(boxed!.plan, join(DATA_DIR, "messages.db")), "the data folder is empty in the box, as on a Cloud").toBe("none");
    expect(visibleInBox(boxed!.plan, socket), "the question tool's socket is in the box").toBe("rw");
  }, 60_000);
});
