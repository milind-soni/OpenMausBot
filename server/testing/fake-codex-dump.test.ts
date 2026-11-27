import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";

it.each([true, false])("Codex dump isolates account probes when turns-only is %s", async (turnsOnly) => {
  const home = mkdtempSync(join(tmpdir(), "omb-codex-dump-"));
  const dump = join(home, "calls.json");
  const children: ChildProcess[] = [];
  const start = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("fake-codex-app-server.ts", import.meta.url)), "app-server"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_CODEX_MODE: "happy",
        FAKE_CODEX_DUMP: dump, FAKE_CODEX_DUMP_TURNS_ONLY: turnsOnly ? "1" : "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    let id = 0;
    return async (method: string, params: object = {}) => {
      const requestId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
      await expect.poll(() => output.split("\n").some(line => {
        try { return JSON.parse(line).id === requestId; } catch { return false; }
      }), { timeout: 10_000 }).toBe(true);
    };
  };
  const calls = () => JSON.parse(readFileSync(dump, "utf8")).calls as Array<{ method: string }>;
  try {
    const turn = start();
    await turn("initialize");
    await turn("thread/start");
    await turn("turn/start", { threadId: "codex-thread-1", input: [] });
    await expect.poll(() => calls().some(call => call.method === "turn/start")).toBe(true);
    await waitForExit(children[0]!, { signal: "SIGTERM" });
    // An account refresh uses the same configured environment but is not
    // the turn whose transport the end-to-end test needs to inspect.
    const account = start();
    await account("initialize");
    await account("account/read");
    expect(calls().some(call => call.method === "turn/start")).toBe(turnsOnly);
    expect(calls().some(call => call.method === "account/read")).toBe(!turnsOnly);
  } finally {
    await Promise.all(children.map(child => waitForExit(child, { signal: "SIGTERM" })));
    await removeTempDir(home);
  }
});
