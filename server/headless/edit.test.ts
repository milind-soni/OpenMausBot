import { describe, expect, it, vi } from "vitest";

import { runHeadless } from "./main.ts";
import type { HeadlessIo } from "./output.ts";

function harness(verb: "edit" | "set-model" = "edit") {
  const callTool = vi.fn(async () => ({ success: true }));
  const request = vi.fn(async (path: string) => {
    if (path !== "/api/bots?messages=0") throw new Error(`unexpected path ${path}`);
    return {
      bots: [{ id: "lead", name: "Lead", threadId: "active", tasks: [{ threadId: "active" }, { threadId: "earlier" }] }],
      groups: [{ id: "room", name: "Room", threadId: "room-thread" }],
    };
  });
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: () => undefined, readStdin: async () => "Corrected request" };
    const options = verb === "edit" ? ["--message", "m1"] : ["--model", "claude/claude-sonnet-5-5"];
    const code = await runHeadless([verb, ...argv, ...options, "--json"], {
      env: { OPENMAUSBOT_URL: "http://127.0.0.1:19999" }, io, callTool: callTool as any, request: request as any,
    });
    return { code, result: JSON.parse(out[0]!) };
  };
  return { callTool, run };
}

describe("edit conversation selection", () => {
  it.each([
    ["Corrected request"],
    ["--text", "Corrected request"],
    ["-"],
  ])("edits a named thread with message arguments %j", async (...message) => {
    const h = harness();
    expect((await h.run(["--thread", "earlier", ...message])).code).toBe(0);
    expect(h.callTool).toHaveBeenCalledWith("edit_bot_message", {
      bot_id: "lead", task_id: "earlier", message_id: "m1", text: "Corrected request",
    }, expect.any(Function), undefined, undefined);
  });

  it.each([["Lead"], ["--bot", "lead"]])("keeps bot selection %j and --task", async (...target) => {
    const h = harness();
    expect((await h.run([...target, "--task", "earlier", "--text", "Corrected request"])).code).toBe(0);
    expect(h.callTool).toHaveBeenCalledWith("edit_bot_message", {
      bot_id: "lead", task_id: "earlier", message_id: "m1", text: "Corrected request",
    }, expect.any(Function), undefined, undefined);
  });

  it("keeps a positional bot and message", async () => {
    const h = harness();
    expect((await h.run(["Lead", "Corrected request"])).code).toBe(0);
    expect(h.callTool).toHaveBeenCalledWith("edit_bot_message", {
      bot_id: "lead", message_id: "m1", text: "Corrected request",
    }, expect.any(Function), undefined, undefined);
  });

  it.each([["--thread", "earlier"], ["--bot", "lead"]])(
    "refuses a positional bot and message alongside %j before editing", async (...target) => {
      const h = harness();
      const result = await h.run(["Lead", "Corrected request", ...target]);
      expect(result.code).toBe(2);
      expect(result.result).toMatchObject({ ok: false, error: expect.stringContaining("one message argument") });
      expect(h.callTool).not.toHaveBeenCalled();
    },
  );

  it("previews the selected thread without editing it", async () => {
    const h = harness();
    const preview = await h.run(["--thread", "earlier", "--text", "Corrected request", "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.result).toMatchObject({ dryRun: true, tool: "edit_bot_message", arguments: { bot_id: "lead", task_id: "earlier" } });
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it.each([["--thread", "room-thread"], ["--thread", "missing"], ["--bot", "lead", "--thread", "earlier"]])(
    "refuses an invalid or conflicting target %j before editing", async (...target) => {
      const h = harness();
      expect((await h.run([...target, "--text", "Corrected request"])).code).toBe(2);
      expect(h.callTool).not.toHaveBeenCalled();
    },
  );
});

describe("set-model conversation selection", () => {
  it.each([
    ["Lead", "--task", "earlier"],
    ["--bot", "lead", "--task", "earlier"],
    ["--thread", "earlier"],
  ])("sets the selected bot thread's model with %j", async (...target) => {
    const h = harness("set-model");
    expect((await h.run(target)).code).toBe(0);
    expect(h.callTool).toHaveBeenCalledWith("set_bot_model", {
      bot_id: "lead", task_id: "earlier", instance_id: "claude", model: "claude-sonnet-5-5",
    }, expect.any(Function), undefined, undefined);
  });

  it.each([
    ["--bot", "lead", "--thread", "earlier"],
    ["--bot", "lead", "--channel", "room"],
    ["--bot", "lead", "Lead"],
  ])("refuses conflicting target %j before changing the model", async (...target) => {
    const h = harness("set-model");
    expect((await h.run(target)).code).toBe(2);
    expect(h.callTool).not.toHaveBeenCalled();
  });
});
