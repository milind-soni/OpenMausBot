import "../testing/scrub-ambient-omb-env.ts";

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { USAGE } from "../cli-usage.ts";
import { HEADLESS_VERBS } from "./args.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless, VERB_HELP } from "./main.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
  return { io, out, err };
}

describe("the headless command line", () => {
  it("prints exactly one JSON document with --json, a failure included", async () => {
    const { io, out, err } = capture();
    const code = await runHeadless(["send", "--bot", "b1", "--json"], { io, env: {} });
    expect(code).toBe(2);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ ok: false, error: "a message is required", hint: expect.any(String), exitCode: 2 });
    expect(err).toEqual([]);
  });

  it("writes errors to stderr without --json", async () => {
    const { io, out, err } = capture();
    expect(await runHeadless(["wait", "--bot", "b1", "--timeout", "forever"], { io, env: {} })).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(["error: --timeout must be a duration from 1s to 24h, such as 90, 90s, 5m or 2h"]);
  });

  it("redacts secrets in everything it prints", async () => {
    const { io, out } = capture();
    const callTool = vi.fn(async () => ({ messages: [{ role: "bot", kind: "text", text: "the key is sk-ant-abcdefghijklmnopqrstuv0123" }] }));
    await runHeadless(["messages", "--bot", "b1", "--json"], { io, env: { OPENMAUSBOT_URL: "http://127.0.0.1:19999" }, callTool: callTool as any });
    expect(out.join("\n")).not.toContain("sk-ant-abcdefghijklmnopqrstuv0123");
    expect(out.join("\n")).toContain("«redacted");
    const human = capture();
    await runHeadless(["messages", "--bot", "b1"], { io: human.io, env: { OPENMAUSBOT_URL: "http://127.0.0.1:19999" }, callTool: callTool as any });
    expect(human.out.join("\n")).not.toContain("sk-ant-abcdefghijklmnopqrstuv0123");
  });

  it("has plain help for every verb, and the main usage names them", async () => {
    for (const verb of HEADLESS_VERBS) expect(VERB_HELP[verb], verb).toBeTruthy();
    const { io, out } = capture();
    expect(await runHeadless(["help", "run"], { io })).toBe(0);
    expect(out[0]).toContain("Give a bot or room one job and wait until it, and every teammate it asked, is done.");
    expect(await runHeadless(["team", "apply", "--help"], { io })).toBe(0);
    expect(out[1]).toContain("a second apply prints \"No changes.\"");
    expect(USAGE).toContain("openmausbot run BOT \"do this\"         give a bot one job and wait until it and every teammate it asked are done");
  });

  it("is reachable through the published entry, which keeps every other command as it was", () => {
    const entry = join(import.meta.dirname, "..", "openmausbot.ts");
    const help = spawnSync(process.execPath, ["--experimental-strip-types", entry, "help", "export"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("openmausbot export TARGET --out DIR");
    const refused = spawnSync(process.execPath, ["--experimental-strip-types", entry, "run", "--json"], { encoding: "utf8", env: { ...process.env, OPENMAUSBOT_URL: "" } });
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, exitCode: 2 });
    const usage = spawnSync(process.execPath, ["--experimental-strip-types", entry, "--help"], { encoding: "utf8" });
    expect(usage.stdout).toContain("openmausbot serve [--port 8799]");
    expect(usage.stdout).toContain("Drive a running workspace");
  });

  it("serves MCP through the published entry, and Ctrl-C ends it like any command", async () => {
    const entry = join(import.meta.dirname, "..", "openmausbot.ts");
    const child = spawn(process.execPath, ["--experimental-strip-types", entry, "mcp"], {
      env: { ...process.env, OPENMAUSBOT_URL: "http://127.0.0.1:19998", OPENMAUSBOT_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on("exit", (code, signal) => done({ code, signal })));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
    await vi.waitFor(() => expect(stdout).toContain('"id":1'), { timeout: 10_000 });
    expect(JSON.parse(stdout.split("\n")[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: expect.stringContaining("openmausbot") } } });
    child.kill("SIGINT");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const { signal } = await exited;
    clearTimeout(timer);
    expect(signal).toBe("SIGINT");
  }, 20_000);
});
