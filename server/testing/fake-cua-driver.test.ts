import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callOutcome } from "../saved-steps/computer-client.ts";
import { resolveStep, type ComputerCaller } from "../saved-steps/resolve.ts";
import { buildRecipe } from "../saved-steps/rules.ts";
import { removeTempDir, waitForExit } from "./cleanup.ts";
import { textEditJournal } from "./saved-steps-fixtures.ts";

const FAKE = fileURLToPath(new URL("fake-cua-driver.ts", import.meta.url));

type Frame = { id?: number; result?: any; error?: { code: number; message: string } };

describe("the fake cua-driver", () => {
  let home = "";
  let log = "";
  let fail = "";
  let hold = "";
  let children: ChildProcess[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-fake-cua-"));
    log = join(home, "cua-calls.jsonl");
    fail = join(home, "fail");
    hold = join(home, "hold");
  });
  afterEach(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    children = [];
    await removeTempDir(home);
  });

  function start() {
    const child = spawn(process.execPath, [FAKE, "mcp"], {
      env: { ...process.env, FAKE_CUA_STATE: join(home, "cua-state.json"), FAKE_CUA_LOG: log, FAKE_CUA_FAIL: fail, FAKE_CUA_HOLD: hold },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const waiting = new Map<number, (frame: Frame) => void>();
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      for (const answer of waiting.values()) answer({ error: { code: -1, message: `the fake exited with ${code}: ${stderr}` } });
    });
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline)) as Frame;
        buffer = buffer.slice(newline + 1);
        if (frame.id !== undefined) waiting.get(frame.id)?.(frame);
      }
    });
    let lastId = 0;
    const rpc = (method: string, params: unknown = {}) => new Promise<Frame>((resolve) => {
      const id = ++lastId;
      waiting.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const frame = await rpc("tools/call", { name, arguments: args });
      if (frame.error) throw new Error(frame.error.message);
      return frame.result;
    };
    return { rpc, call };
  }

  const loggedNames = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).name);

  it("hands out fresh tokens per snapshot and refuses stale ones", async () => {
    const { rpc, call } = start();
    expect((await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result.serverInfo.name).toBe("cua-driver");
    expect((await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_apps", "list_windows", "get_window_state", "click", "set_value"]);
    expect((await call("get_window_state", { pid: 4242, window_id: 7 })).structuredContent.elements[2].element_token).toBe("s1-e2");
    expect((await call("get_window_state", { pid: 4242, window_id: 7 })).structuredContent.elements[2].element_token).toBe("s2-e2");
    const stale = await call("click", { element_token: "s1-e2" });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain("stale element token");
    expect((await call("click", { element_token: "s2-e2" })).isError).toBeUndefined();
    expect(loggedNames()).toEqual(["get_window_state", "get_window_state", "click", "click"]);
  });

  it("answers in cua-driver 0.28.2's shapes: a whole tree for the window asked, and a pid on every app and window", async () => {
    const { call } = start();
    const state = (await call("get_window_state", { pid: 4242, window_id: 7, include_screenshot: false })).structuredContent;
    expect(state).toMatchObject({ pid: 4242, window_id: 7, app_name: "TextEdit", window_title: "Untitled", elements_complete: true });
    expect([state.element_count, state.returned_element_count, state.total_element_count]).toEqual([4, 4, 4]);
    expect(state.elements).toHaveLength(4);
    const { apps } = (await call("list_apps")).structuredContent;
    expect(apps).toContainEqual(expect.objectContaining({ pid: 4242, name: "TextEdit", bundle_id: "com.apple.TextEdit" }));
    expect(apps.every((app: { pid: unknown; name: unknown; bundle_id: unknown }) =>
      typeof app.pid === "number" && typeof app.name === "string" && typeof app.bundle_id === "string")).toBe(true);
    const all = (await call("list_windows")).structuredContent.windows;
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((window: { pid: unknown }) => typeof window.pid === "number")).toBe(true);
    expect((await call("list_windows", { pid: 4242 })).structuredContent.windows).toEqual([expect.objectContaining({ window_id: 7, pid: 4242, title: "Untitled" })]);
    expect((await call("get_window_state", { pid: 4242, window_id: 8 })).isError).toBe(true);
  });

  it("keeps one snapshot count across driver processes", async () => {
    expect((await start().call("get_window_state", { pid: 4242, window_id: 7 })).structuredContent.elements[2].element_token).toBe("s1-e2");
    const second = start();
    expect((await second.call("get_window_state", { pid: 4242, window_id: 7 })).structuredContent.elements[2].element_token).toBe("s2-e2");
    expect((await second.call("set_value", { element_token: "s1-e2", value: "hello" })).isError).toBe(true);
  });

  it("fails one set_value on a live element per touch of the fail file", async () => {
    const { call } = start();
    await call("get_window_state", { pid: 4242, window_id: 7 });
    writeFileSync(fail, "");
    expect((await call("click", { element_token: "s1-e2" })).isError).toBeUndefined();
    expect((await call("set_value", { element_token: "s0-e2", value: "hello world" })).content[0].text).toContain("unknown element token");
    expect(existsSync(fail)).toBe(true);
    expect(await call("set_value", { element_token: "s1-e2", value: "hello world" })).toEqual({ content: [{ type: "text", text: "Fixture failure." }], isError: true });
    expect(existsSync(fail)).toBe(false);
    expect((await call("set_value", { element_token: "s1-e2", value: "hello world" })).isError).toBeUndefined();
  });

  it("holds an action while the hold file exists", async () => {
    const { call } = start();
    await call("get_window_state", { pid: 4242, window_id: 7 });
    writeFileSync(hold, "");
    let answered = false;
    const click = call("click", { element_token: "s1-e2" }).then((result) => {
      answered = true;
      return result;
    });
    await expect.poll(() => existsSync(log) && loggedNames().includes("click")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(answered).toBe(false);
    rmSync(hold);
    expect((await click).isError).toBeUndefined();
  });

  it("is a window the saved-steps resolver accepts as it would the real driver", async () => {
    const { call } = start();
    const built = buildRecipe({ request: "Open TextEdit and type hello world", journal: textEditJournal(), id: "r1", now: 1 });
    if (!built.ok) throw new Error(built.reason);
    const caller: ComputerCaller = { call: async (tool, args) => callOutcome(await call(tool, args)) };
    const signal = new AbortController().signal;
    expect(await resolveStep(built.recipe.steps[0]!, caller, signal)).toEqual({ ok: true, args: { pid: 4242, window_id: 7, element_token: "s1-e2" } });
    expect(await resolveStep(built.recipe.steps[1]!, caller, signal)).toEqual({ ok: true, args: { value: "hello world", pid: 4242, window_id: 7, element_token: "s2-e2" } });
  });
});
