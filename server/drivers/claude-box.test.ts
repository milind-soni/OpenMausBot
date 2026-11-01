// A Claude turn where the bot box is on (every Cloud home): the engine and the helpers it starts see only what the box puts
// back, and the data folder is empty in there. The question tool's helper reaches the broker through a socket the driver
// makes in the data folder, and the hook helper reads its bearer from a file there, so the box must put both back. Off a
// Cloud the box is off and nothing changes.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { ClaudeDriver, hookTokenFile } from "./claude.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const KNOBS = ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_TOOL_CALLS", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_HOOKS"] as const;

/** A stand-in for bubblewrap with no namespaces: it runs what follows `--`, but first reads its mount lines as bubblewrap
 * applies them, the last line over a path deciding, and when none puts the hook token back the token is not there, as in
 * a real box whose data folder is an empty one. */
const HIDING_BWRAP = `#!/bin/sh
shown=1
while [ "$1" != "--" ]; do
  case "$1" in
    --bind|--bind-try|--ro-bind|--ro-bind-try) case "$OMB_HOOK_TOKEN_FILE" in "$3"|"$3"/*) shown=1;; esac; shift 3;;
    --tmpfs|--dir|--proc|--dev) case "$OMB_HOOK_TOKEN_FILE" in "$2"|"$2"/*) shown=0;; esac; shift 2;;
    --symlink) shift 3;;
    --chdir|--hostname|--seccomp) shift 2;;
    *) shift;;
  esac
done
shift
if [ "$shown" = 0 ] && [ -n "$OMB_HOOK_TOKEN_FILE" ]; then OMB_HOOK_TOKEN_FILE="$OMB_HOOK_TOKEN_FILE.not-in-the-box"; export OMB_HOOK_TOKEN_FILE; fi
exec "$@"
`;
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

  it.skipIf(process.platform === "win32")("puts only the conversation's hook token in the box, read-only, so its hooks fire from inside", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-claude-box-hooks-"));
    dirs.push(scratch);
    const fakeBwrap = join(scratch, "fake-bwrap.sh");
    writeFileSync(fakeBwrap, HIDING_BWRAP);
    chmodSync(fakeBwrap, 0o755);
    await botBox.start({
      dataDir: DATA_DIR, home: homedir(), port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: fakeBwrap, socat: "/usr/bin/true" } }),
    });
    const wrap = vi.spyOn(botBox, "wrap");
    delete process.env.TMPDIR;
    // The harness's hook route: what the helper in the box posts each hook to, with the turn's bearer.
    const hooks: Array<{ authorization: string | undefined; event: string }> = [];
    const harness: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/api/internal/hook") hooks.push({ authorization: req.headers.authorization, event: JSON.parse(body).event });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
    try {
      process.env.FAKE_CLAUDE_HOOKS = "1";
      instance = await ClaudeDriver.create({ instanceId: "claude-box", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
      const recorder = recordEvents(instance.adapter);
      const cwd = join(DATA_DIR, "task-workspaces", "bot-a", "t-boxed-hooks");
      mkdirSync(cwd, { recursive: true });
      const url = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`;

      await instance.adapter.sendTurn({ threadId: "t-boxed-hooks", botId: "bot-a", text: "hi", approvalMode: "full", cwd, integrations: { hooks: { url, token: "hook-bearer-1" } } });
      await recorder.until((event) => event.type === "turn.completed", 30_000);

      expect(hooks.map((hook) => hook.event), "the hooks fired from inside the box").toEqual(expect.arrayContaining(["PostToolUse", "Stop"]));
      for (const hook of hooks) expect(hook.authorization).toBe("Bearer hook-bearer-1");
      const boxed = wrap.mock.results.map((result) => result.value as WrappedSpawn | null).find((spawned) => spawned?.plan.botId === "bot-a");
      expect(boxed, "the engine ran in the box").toBeTruthy();
      const token = hookTokenFile("t-boxed-hooks", "bot-a");
      expect(visibleInBox(boxed!.plan, token), "the conversation's token, read-only").toBe("ro");
      // Its own folder, not the file: a later turn renames a new token over the file, and a bind of the file would keep the old.
      expect(boxed!.plan.mounts).toContainEqual({ kind: "ro", source: dirname(token), target: dirname(token), optional: true });
      expect(visibleInBox(boxed!.plan, hookTokenFile("t-another", "bot-a")), "another conversation's token").toBe("none");
      expect(visibleInBox(boxed!.plan, dirname(dirname(token))), "the folder of every token").toBe("none");
      expect(visibleInBox(boxed!.plan, join(DATA_DIR, "messages.db"))).toBe("none");
    } finally {
      await new Promise<void>((resolve) => harness.close(() => resolve()));
    }
  }, 60_000);
});
