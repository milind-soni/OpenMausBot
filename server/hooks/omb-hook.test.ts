// The hook helper Claude Code runs at PostToolUse etc. (Phase 0, item 0.2).
// Contract, learned the hard way by others: it ALWAYS exits 0, never takes
// longer than its budget, speaks only to the loopback harness, and prints a
// hookSpecificOutput block only when the harness returned one.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "omb-hook.ts");
const dir = mkdtempSync(join(tmpdir(), "omb-hook-"));
const tokenFile = join(dir, "token");
writeFileSync(tokenFile, "secret-token-123\n", { mode: 0o600 });
const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) s.close();
  await removeTempDir(dir);
});

function run(stdin: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HELPER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("omb-hook helper", () => {
  it("exits 0 quietly on garbage input and no harness", async () => {
    const r = run("not json at all", { OMB_HOOK_URL: "http://127.0.0.1:1", OMB_HOOK_TOKEN_FILE: tokenFile });
    const result = await r;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  }, 15_000);

  it("posts the event with the bearer from the token file and prints the harness's hookSpecificOutput", async () => {
    const seen: Array<{ auth: string | undefined; body: unknown }> = [];
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "remember the digest" } }));
      });
    });
    const payload = { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: "tu-1", tool_input: { command: "ls" }, tool_response: "a\nb" };
    const result = await run(JSON.stringify(payload), { OMB_HOOK_URL: url, OMB_HOOK_TOKEN_FILE: tokenFile });
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer secret-token-123");
    expect(seen[0]!.body).toEqual({ event: "PostToolUse", payload });
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "remember the digest" } });
  }, 15_000);

  it("gives up within its budget when the harness never answers, still exiting 0", async () => {
    const url = await listen(() => { /* never respond */ });
    const result = await run(JSON.stringify({ hook_event_name: "Stop" }), { OMB_HOOK_URL: url, OMB_HOOK_TOKEN_FILE: tokenFile, OMB_HOOK_TIMEOUT_MS: "800" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.ms).toBeLessThan(5_000);
  }, 15_000);

  it("prints nothing when the harness returns no hookSpecificOutput", async () => {
    const url = await listen((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); });
    const result = await run(JSON.stringify({ hook_event_name: "PostToolUse", tool_use_id: "x" }), { OMB_HOOK_URL: url, OMB_HOOK_TOKEN_FILE: tokenFile });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  }, 15_000);
});

describe("omb-hook helper: SessionStart context", () => {
  it("prints the harness's plain-text context on SessionStart, because Claude Code reads stdout as context there", async () => {
    const url = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, context: "[What Dev did in an earlier turn: tools: Bash ×3 · files: changed retry.ts]" }));
    });
    const result = await run(JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s1" }), { OMB_HOOK_URL: url, OMB_HOOK_TOKEN_FILE: tokenFile });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("[What Dev did in an earlier turn: tools: Bash ×3 · files: changed retry.ts]");
  }, 15_000);

  it("ignores a context field on events where stdout is not context", async () => {
    const url = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, context: "should not be printed" }));
    });
    const result = await run(JSON.stringify({ hook_event_name: "PostToolUse", tool_use_id: "t" }), { OMB_HOOK_URL: url, OMB_HOOK_TOKEN_FILE: tokenFile });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  }, 15_000);
});
