// OpenMausBot's own connection to a command MCP server (an app's page and calls) where the bot box is on: the command is
// one a bot's turns also start, and may be the bot's own, so it starts in the box, where the data folder is an empty one.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botBox, type WrappedSpawn } from "./bot-box/box.ts";
import { visibleInBox } from "./bot-box/plan.ts";
import { DATA_DIR, ensureDirs } from "./config.ts";
import { AppConnections } from "./mcp-app-connections.ts";
import { removeTempDir } from "./testing/cleanup.ts";

/** A stand-in for bubblewrap with no namespaces: it runs what follows `--`, and what it runs can tell it is inside. */
const MARKING_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
IN_FAKE_BOX=inside; export IN_FAKE_BOX
exec "$@"
`;
/** Says where it started, then answers nothing: the connection gives up on it. */
const server = (marker: string) => ({ command: "/bin/sh", args: ["-c", 'printf "%s\\n" "${IN_FAKE_BOX:-outside}" >> "$0"', marker], env: { BOARD_KEY: "k" } });
const TMPDIR = process.env.TMPDIR;

describe.skipIf(process.platform === "win32")("an app's connection to a command server", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await botBox.stop();
    if (TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = TMPDIR;
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  it("starts the command in the bot box where turns are boxed: as its bot, or with no bot's folder", async () => {
    ensureDirs();
    const scratch = mkdtempSync(join(tmpdir(), "omb-app-box-"));
    dirs.push(scratch);
    const fakeBwrap = join(scratch, "fake-bwrap.sh");
    writeFileSync(fakeBwrap, MARKING_BWRAP);
    chmodSync(fakeBwrap, 0o755);
    await botBox.start({
      dataDir: DATA_DIR, home: homedir(), port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: fakeBwrap, socat: "/usr/bin/true" } }),
    });
    const wrap = vi.spyOn(botBox, "wrap");
    delete process.env.TMPDIR;
    const marker = join(scratch, "started.txt");
    const own = join(DATA_DIR, "workspaces", "bot-a");
    mkdirSync(own, { recursive: true });
    const connections = new AppConnections({ asBot: (name) => (name === "own" ? { id: "bot-a", cwd: own } : {}) });
    try {
      await expect(connections.request("own", server(marker), "resources/list", {}, AbortSignal.timeout(20_000))).rejects.toThrow();
      await expect(connections.request("shared", server(`${marker}.shared`), "resources/list", {}, AbortSignal.timeout(20_000))).rejects.toThrow();
    } finally {
      connections.closeAll();
    }
    expect(readFileSync(marker, "utf8").trim()).toBe("inside");
    expect(readFileSync(`${marker}.shared`, "utf8").trim()).toBe("inside");
    const [asBot, asAny] = wrap.mock.results.map((result) => result.value as WrappedSpawn);
    expect(asBot!.plan.botId).toBe("bot-a");
    expect(visibleInBox(asBot!.plan, own)).toBe("rw");
    expect(asAny!.plan.botId).toBeNull();
    for (const plan of [asBot!.plan, asAny!.plan]) {
      expect(plan.net).toBe("isolated");
      for (const hidden of ["messages.db", "config.json", join("workspaces", "bot-b")]) expect(visibleInBox(plan, join(DATA_DIR, hidden)), hidden).toBe("none");
    }
    expect(visibleInBox(asAny!.plan, own), "no bot's folder for a server that is every bot's").toBe("none");
    // The keys the person saved for the server are its own to read.
    expect(asBot!.env.BOARD_KEY).toBe("k");
  }, 60_000);

  it("with the box off, starts it as it did", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-app-nobox-"));
    dirs.push(scratch);
    const marker = join(scratch, "started.txt");
    const connections = new AppConnections({ asBot: () => ({ id: "bot-a", cwd: join(scratch, "missing") }) });
    try {
      await expect(connections.request("own", server(marker), "resources/list", {}, AbortSignal.timeout(20_000))).rejects.toThrow();
    } finally {
      connections.closeAll();
    }
    expect(readFileSync(marker, "utf8").trim()).toBe("outside");
  }, 60_000);
});
