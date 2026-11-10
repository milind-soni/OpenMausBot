import { afterEach, describe, expect, it, vi } from "vitest";

// scripts/mcp-server.ts snapshots process.env at import time: scrub ambient OMB_* / OPENMAUSBOT_* values first.
import "./testing/scrub-ambient-omb-env.ts";

import {
  handleToolCall,
  OpenMausBotApiError,
  probeBaseUrls,
  processMcpMessage,
  request,
  resolveBaseUrl,
  TOOLS,
  validateBaseUrl,
  validateToolArguments,
} from "../scripts/mcp-server.ts";

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.OPENMAUSBOT_TOKEN;
  delete process.env.ALLOW_INSECURE_HTTP;
});

describe("MCP JSON-RPC protocol", () => {
  it("negotiates supported and newer protocol versions", async () => {
    const supported = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })))!);
    expect(supported.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "openmausbot-mcp", version: "1.1.0" },
      capabilities: { tools: {} },
    });

    const future = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "future",
      method: "initialize",
      params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })))!);
    expect(future.result.protocolVersion).toBe("2025-11-25");
  });

  it("lists a closed, annotated orchestration surface", async () => {
    const response = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!);
    const names = response.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(TOOLS.map((tool) => tool.name));
    expect(names).toContain("create_bot");
    expect(names).toContain("create_channel");
    expect(names).toContain("wait_for_conversation");
    expect(names).toContain("interrupt_conversation");
    expect(names).not.toContain("wait_for_bot");
    expect(names).not.toContain("interrupt_bot");
    expect(names).not.toContain("approve_request");
    expect(names).not.toContain("delete_bot");
    expect(response.result.tools.every((tool: any) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(response.result.tools.every((tool: any) => tool.annotations)).toBe(true);
  });

  it("requires the MCP initialize identity and capabilities fields", async () => {
    const response = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2025-11-25" },
    })))!);
    expect(response.error).toMatchObject({ code: -32602 });
  });

  it("returns structured and text tool results", async () => {
    const handler = vi.fn(async () => ({ bots: [{ id: "bot-1" }] })) as any;
    const response = JSON.parse((await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_bots", arguments: {} },
    }), handler))!);
    expect(response.result.structuredContent).toEqual({ bots: [{ id: "bot-1" }] });
    expect(JSON.parse(response.result.content[0].text)).toEqual(response.result.structuredContent);
  });

  it("rejects unknown tools and malformed arguments as invalid params", async () => {
    for (const params of [
      { name: "does_not_exist", arguments: {} },
      { name: "send_bot_message", arguments: { bot_id: "bot-1", text: { not: "text" } } },
      { name: "list_bots", arguments: { unexpected: true } },
    ]) {
      const response = JSON.parse((await processMcpMessage(JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call", params,
      })))!);
      expect(response.error.code).toBe(-32602);
    }
  });

  it("handles parse errors, method errors, pings, and notifications", async () => {
    expect(JSON.parse((await processMcpMessage("not json"))!).error.code).toBe(-32700);
    expect(JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "nope" })))!).error.code).toBe(-32601);
    expect(JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" })))!).result).toEqual({});
    expect(await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
  });

  it("cancels an in-flight tool call with the MCP cancellation notification", async () => {
    const handler = vi.fn(async (_name, _args, _fetcher, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as any;
    const pending = processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: "slow-call",
      method: "tools/call",
      params: {
        name: "wait_for_conversation",
        arguments: { target_type: "bot", target_id: "bot-1" },
      },
    }), handler);
    expect(await processMcpMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "slow-call", reason: "client closed" },
    }))).toBeNull();
    expect(JSON.parse((await pending)!)).toEqual({
      jsonrpc: "2.0",
      id: "slow-call",
      error: { code: -32800, message: "Request cancelled" },
    });
  });
});

describe("MCP tool execution", () => {
  it("lists bots without fetching transcripts", async () => {
    const fetcher = vi.fn(async (path: string) => {
      expect(path).toBe("/api/bots?messages=0");
      return {
        bots: [{
          id: "bot-1", name: "Deckard", title: "Detective", busy: false, activity: "idle",
          threadId: "task-1", messages: [], tasks: [{
            threadId: "task-1", title: "Case", createdAt: 10, busy: false, activity: "idle",
            modelSelection: { instanceId: "fake", model: "fake-model" },
          }],
        }],
      };
    });
    const result: any = await handleToolCall("list_bots", {}, fetcher);
    expect(result.bots[0]).toMatchObject({ id: "bot-1", activeTaskId: "task-1", activity: "idle" });
    expect(result.bots[0].tasks[0]).toMatchObject({
      taskId: "task-1", active: true, busy: false, activity: "idle",
      modelSelection: { instanceId: "fake", model: "fake-model" },
    });
    expect(result.bots[0]).not.toHaveProperty("messages");
  });

  it("reads a bounded bot task and removes pixels and approval grant keys", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Deckard", threadId: "task-1", tasks: [{ threadId: "task-1", title: "Case" }] }],
      };
      if (path === "/api/threads/task-1/messages?limit=200") return {
        messages: [{
          id: "m1", at: 123, role: "bot", kind: "screen", png: "base64-pixels",
          tool: { name: "Browser", ok: false, spoken: "browser failed", setup: true, raw: "drop" },
          card: { title: "Run command?", requestId: "secret-request", allowKey: "Bash:git", answered: false },
        }],
        hasMore: true,
      };
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("get_bot_messages", { bot_id: "bot-1", limit: 200 }, fetcher);
    expect(result.messages[0]).toMatchObject({
      id: "m1", at: 123, hasImage: true,
      tool: { name: "Browser", ok: false, spoken: "browser failed", setup: true },
    });
    expect(result.messages[0]).not.toHaveProperty("png");
    expect(result.messages[0].card).not.toHaveProperty("allowKey");
    expect(result.messages[0].card).not.toHaveProperty("requestId");
    expect(result.hasMore).toBe(true);
  });

  it("pins bot sends to any owned task and channel sends to the active task", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{
          id: "bot-1", threadId: "bot-task", tasks: [
            { threadId: "bot-task" },
            { threadId: "bot-old" },
          ],
        }],
        groups: [{
          id: "channel-1", threadId: "channel-task", tasks: [
            { threadId: "channel-task" },
            { threadId: "channel-old" },
          ],
        }],
      };
      if (path === "/api/bots/bot-1/messages") {
        const body = JSON.parse(String(options?.body));
        expect(body).toEqual(body.text === "Background investigation"
          ? { text: "Background investigation", threadId: "bot-old" }
          : { text: "Investigate", threadId: "bot-task" });
        return { ok: true };
      }
      if (path === "/api/groups/channel-1/messages") {
        expect(JSON.parse(String(options?.body))).toEqual({ text: "Ship it", threadId: "channel-task" });
        return { ok: true };
      }
      throw new Error(`unexpected path ${path}`);
    });

    await expect(handleToolCall("send_bot_message", {
      bot_id: "bot-1", task_id: "not-owned", text: "Wrong task",
    }, fetcher)).rejects.toThrow("does not belong");
    await expect(handleToolCall("send_bot_message", {
      bot_id: "bot-1", task_id: "bot-old", text: "Background investigation",
    }, fetcher)).resolves.toMatchObject({ success: true, taskId: "bot-old" });
    await expect(handleToolCall("send_channel_message", {
      channel_id: "channel-1", task_id: "channel-old", text: "Wrong task",
    }, fetcher)).rejects.toThrow("not active");

    await expect(handleToolCall("send_bot_message", {
      bot_id: "bot-1", text: "Investigate",
    }, fetcher)).resolves.toMatchObject({ success: true, taskId: "bot-task" });
    await expect(handleToolCall("send_channel_message", {
      channel_id: "channel-1", text: "Ship it",
    }, fetcher)).resolves.toMatchObject({ success: true, taskId: "channel-task" });
  });

  it("creates a bot through the safe profile boundary", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots" && options?.method === "POST") {
        expect(JSON.parse(String(options.body))).toEqual({ name: "Mira", title: "Researcher", section: "Work" });
        return { bot: { id: "bot-new", name: "Mira", title: "Researcher", section: "Work", threadId: "task-new", tasks: [] } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("create_bot", { name: "Mira", title: "Researcher", section: "Work" }, fetcher);
    expect(result.bot).toMatchObject({ id: "bot-new", name: "Mira", section: "Work" });
  });

  it("leaves single-request bot-create failures to the server without destructive rollback", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      calls.push(`${options?.method ?? "GET"} ${path}`);
      if (path === "/api/bots" && options?.method === "POST") throw new Error("profile rejected");
      throw new Error(`unexpected path ${path}`);
    });
    await expect(handleToolCall("create_bot", { name: "Mira" }, fetcher)).rejects.toThrow("profile rejected");
    expect(calls).toEqual(["POST /api/bots"]);
  });

  it("creates and completes channel setup in one request", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/groups") {
        expect(JSON.parse(String(options?.body))).toEqual({
          name: "Launch",
          memberIds: ["bot-1", "bot-2"],
          section: "Work",
          setup: { bulletin: "Ship safely", defaultResponder: { kind: "everyone" } },
        });
        return { group: { id: "channel-1", name: "Launch", memberIds: ["bot-1", "bot-2"], threadId: "task-1", tasks: [] } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("create_channel", {
      name: "Launch", member_ids: ["bot-1", "bot-2"], section: "Work", bulletin: "Ship safely",
      default_responder: { kind: "everyone" },
    }, fetcher);
    expect(result.channel.id).toBe("channel-1");
  });

  it("routes bot and channel task mutations", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/groups/channel-1/tasks") {
        return { task: { threadId: "task-2", title: "Fresh" }, group: { threadId: "task-2" } };
      }
      if (path === "/api/bots/bot-1/tasks/task-2?messages=0") {
        return {
          bot: {
            id: "bot-1", name: "Mira", threadId: "task-2",
            tasks: [{ threadId: "task-2", title: "Fresh", cwd: "/private/project" }],
            messages: [{ png: "pixels", card: { allowKey: "Shell:rm" } }],
            resumeCursors: { codex: "session" },
          },
        };
      }
      return { path, method: options?.method, task: { threadId: "task-2", title: "Fresh" } };
    });
    const created: any = await handleToolCall("create_task", { target_type: "channel", target_id: "channel-1", title: "Fresh" }, fetcher);
    expect(fetcher).toHaveBeenLastCalledWith("/api/groups/channel-1/tasks", expect.objectContaining({ method: "POST" }));
    expect(created.task.taskId).toBe("task-2");
    const switched: any = await handleToolCall("switch_task", {
      target_type: "bot", target_id: "bot-1", task_id: "task-2",
    }, fetcher);
    expect(fetcher).toHaveBeenLastCalledWith("/api/bots/bot-1/tasks/task-2?messages=0", expect.objectContaining({ method: "POST" }));
    expect(JSON.stringify(switched)).not.toContain("/private/project");
    expect(JSON.stringify(switched)).not.toContain("pixels");
    expect(JSON.stringify(switched)).not.toContain("Shell:rm");
    expect(JSON.stringify(switched)).not.toContain("session");
  });

  it("rejects incomplete mutation responses before projecting them", async () => {
    const fetcher = vi.fn(async () => ({}));

    await expect(handleToolCall("update_bot_profile", {
      bot_id: "bot-1", name: "Mira",
    }, fetcher)).rejects.toThrow("OpenMausBot did not return the updated bot");
    await expect(handleToolCall("update_channel", {
      channel_id: "channel-1", name: "Launch",
    }, fetcher)).rejects.toThrow("OpenMausBot did not return the updated channel");
    await expect(handleToolCall("create_task", {
      target_type: "bot", target_id: "bot-1", title: "Fresh",
    }, fetcher)).rejects.toThrow("OpenMausBot did not return the created task");
    await expect(handleToolCall("rename_task", {
      target_type: "bot", target_id: "bot-1", task_id: "task-1", title: "Renamed",
    }, fetcher)).rejects.toThrow("OpenMausBot did not return the renamed task");
  });

  it("searches with encoded, bounded parameters", async () => {
    const fetcher = vi.fn(async () => ({ hits: [{ messageId: "m1" }] }));
    const result: any = await handleToolCall("search_messages", { query: "release notes", task_id: "task-1", limit: 100 }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/search?q=release+notes&limit=100&threadId=task-1");
    expect(result.hits).toHaveLength(1);
  });

  it("rewinds a thread by editing an earlier message, and refuses while busy", async () => {
    const busyFetcher = vi.fn(async () => ({ bots: [{ id: "bot-1", busy: true }] }));
    await expect(handleToolCall("edit_bot_message", {
      bot_id: "bot-1", message_id: "m-9", text: "say that again",
    }, busyFetcher)).rejects.toThrow("let it finish");

    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return { bots: [{ id: "bot-1", busy: false }] };
      if (path === "/api/bots/bot-1/messages/m-9/edit") {
        expect(options?.method).toBe("POST");
        expect(JSON.parse(String(options?.body))).toEqual({ text: "say that again" });
        return { ok: true, message: { id: "m-new", role: "user", text: "say that again" } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("edit_bot_message", {
      bot_id: "bot-1", message_id: "m-9", text: "say that again",
    }, fetcher);
    expect(result).toMatchObject({ success: true, botId: "bot-1", message: { id: "m-new" } });
  });

  it("edits inside a named task only when that task is idle and owned", async () => {
    const bot = {
      id: "bot-1", busy: true, threadId: "task-1",
      tasks: [{ threadId: "task-1", busy: true }, { threadId: "task-2", busy: false }],
    };
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return { bots: [bot] };
      if (path === "/api/bots/bot-1/messages/m-9/edit") {
        expect(JSON.parse(String(options?.body))).toEqual({ text: "again", threadId: "task-2" });
        return { ok: true, message: { id: "m-new" } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await expect(handleToolCall("edit_bot_message", {
      bot_id: "bot-1", message_id: "m-9", text: "again", task_id: "task-2",
    }, fetcher)).resolves.toMatchObject({ success: true });
    await expect(handleToolCall("edit_bot_message", {
      bot_id: "bot-1", message_id: "m-9", text: "again", task_id: "task-1",
    }, fetcher)).rejects.toThrow("let it finish");
    await expect(handleToolCall("edit_bot_message", {
      bot_id: "bot-1", message_id: "m-9", text: "again", task_id: "task-9",
    }, fetcher)).rejects.toThrow("does not belong");
  });

  it("will not rewind to an empty message", async () => {
    const fetcher = vi.fn();
    await expect(handleToolCall("edit_bot_message", {
      bot_id: "bot-1", message_id: "m-9", text: "   ",
    }, fetcher as never)).rejects.toThrow("text is required");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires an exact available model and refuses changes while busy", async () => {
    const busyFetcher = vi.fn(async () => ({ bots: [{ id: "bot-1", busy: true }] }));
    await expect(handleToolCall("set_bot_model", {
      bot_id: "bot-1", instance_id: "codex", model: "gpt-5.6-sol",
    }, busyFetcher)).rejects.toThrow("let it finish");

    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return { bots: [{ id: "bot-1", busy: false }] };
      if (path === "/api/instances") return { instances: [{
        instanceId: "codex", snapshot: { state: "available" },
        models: { default: "gpt-5.6-sol", options: [{ id: "gpt-5.6-sol" }] },
        capabilities: { effortLevels: ["high"] },
      }] };
      if (path === "/api/bots/bot-1") {
        expect(JSON.parse(String(options?.body))).toEqual({
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", effort: "high" },
          requireAvailableModel: true,
        });
        return {
          bot: {
            id: "bot-1",
            name: "Mira",
            threadId: "task-1",
            tasks: [{ threadId: "task-1", cwd: "/secret/work", resumeCursors: { codex: "native-session" } }],
            messages: [{ png: "pixels", card: { allowKey: "Bash:git" } }],
            alwaysAllow: ["Bash:git"],
            resumeCursors: { codex: "native-session" },
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await expect(handleToolCall("set_bot_model", {
      bot_id: "bot-1", instance_id: "codex", model: "made-up",
    }, fetcher)).rejects.toThrow("not offered");
    const result: any = await handleToolCall("set_bot_model", {
      bot_id: "bot-1", instance_id: "codex", model: "gpt-5.6-sol", effort: "high",
    }, fetcher);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/secret/work");
    expect(JSON.stringify(result)).not.toContain("native-session");
    expect(JSON.stringify(result)).not.toContain("Bash:git");
    expect(JSON.stringify(result)).not.toContain("pixels");
  });

  it("changes an idle task model while another task of the same bot works", async () => {
    const modelSelection = { instanceId: "codex", model: "gpt-5.6-sol" };
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", threadId: "task-a", busy: true, activity: "working", tasks: [
          { threadId: "task-a", busy: true, activity: "working" },
          { threadId: "task-b", busy: false, activity: "idle" },
        ] }],
      };
      if (path === "/api/instances") return { instances: [{
        instanceId: "codex", snapshot: { state: "available" },
        models: { default: "gpt-5.6-sol", options: [{ id: "gpt-5.6-sol" }] },
      }] };
      if (path === "/api/bots/bot-1/tasks/task-b") {
        expect(options?.method).toBe("PATCH");
        expect(JSON.parse(String(options?.body))).toEqual({ modelSelection, requireAvailableModel: true });
        return { task: { threadId: "task-b", busy: false, activity: "idle", modelSelection, resumeCursors: { codex: "secret" } } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const args = { bot_id: "bot-1", instance_id: "codex", model: "gpt-5.6-sol" };
    await expect(handleToolCall("set_bot_model", { ...args, task_id: "task-a" }, fetcher)).rejects.toThrow("let it finish");
    await expect(handleToolCall("set_bot_model", { ...args, task_id: "other-bot-task" }, fetcher)).rejects.toThrow("does not belong");
    const result: any = await handleToolCall("set_bot_model", { ...args, task_id: "task-b" }, fetcher);
    expect(result).toMatchObject({ success: true, botId: "bot-1", task: { taskId: "task-b", active: false, modelSelection } });
    expect(result.task).not.toHaveProperty("resumeCursors");
  });

  it("interrupts pinned task A while B is selected and refuses an unowned task", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return { bots: [{
        id: "bot-1", threadId: "task-b", busy: true, tasks: [
          { threadId: "task-a", busy: true, activity: "working" },
          { threadId: "task-b", busy: true, activity: "working" },
        ],
      }] };
      if (path === "/api/bots/bot-1/interrupt") {
        expect(options?.method).toBe("POST");
        expect(JSON.parse(String(options?.body))).toEqual({ threadId: "task-a" });
        return { ok: true };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await expect(handleToolCall("interrupt_conversation", {
      target_type: "bot", target_id: "bot-1", task_id: "task-a",
    }, fetcher)).resolves.toEqual({ success: true, targetType: "bot", targetId: "bot-1", taskId: "task-a" });
    await expect(handleToolCall("interrupt_conversation", {
      target_type: "bot", target_id: "bot-1", task_id: "another-task",
    }, fetcher)).rejects.toThrow("does not belong");
    expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/interrupt"))).toHaveLength(1);
  });

  it("guards a bot speaking in a room thread, sends to a room's parallel thread, and stops a room on its exact thread", async () => {
    const sent: Array<{ path: string; body: unknown }> = [];
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", threadId: "own", busy: true, activity: "working", tasks: [] }],
        groups: [{ id: "channel-1", name: "Launch", memberIds: ["bot-1"], threadId: "task-1", busyBotId: null, tasks: [
          { threadId: "task-1", title: "Open", working: false, busyBotId: null },
          { threadId: "task-2", title: "Background", working: true, busyBotId: "bot-1" },
        ] }],
      };
      if (path === "/api/groups/channel-1/messages" || path === "/api/groups/channel-1/interrupt") {
        sent.push({ path, body: JSON.parse(String(options?.body)) });
        return { ok: true };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await expect(handleToolCall("send_bot_message", { bot_id: "bot-1", text: "hi" }, fetcher)).rejects.toThrow("is working in channel 'channel-1'");
    await expect(handleToolCall("send_channel_message", { channel_id: "channel-1", task_id: "task-2", text: "More" }, fetcher))
      .resolves.toMatchObject({ success: true, taskId: "task-2" });
    await expect(handleToolCall("interrupt_conversation", { target_type: "channel", target_id: "channel-1", task_id: "task-2" }, fetcher))
      .resolves.toEqual({ success: true, targetType: "channel", targetId: "channel-1", taskId: "task-2" });
    expect(sent).toEqual([
      { path: "/api/groups/channel-1/messages", body: { text: "More", threadId: "task-2" } },
      { path: "/api/groups/channel-1/interrupt", body: { threadId: "task-2" } },
    ]);
  });

  it("does not expose executable paths from the model catalog", async () => {
    const fetcher = vi.fn(async () => ({ instances: [{
      instanceId: "codex", displayName: "Codex", snapshot: { state: "available" }, models: {}, capabilities: {},
      cli: "/secret/bin/codex", cliCandidates: ["/secret/bin/codex"], install: { command: "secret" },
    }] }));
    const result: any = await handleToolCall("list_available_models", {}, fetcher);
    expect(result.instances[0]).not.toHaveProperty("cli");
    expect(result.instances[0]).not.toHaveProperty("cliCandidates");
    expect(result.instances[0]).not.toHaveProperty("install");
    expect(result.instances[0].snapshot).toEqual({ state: "available" });
  });
});

describe("waiting on a conversation's job", () => {
  function server(options: { fleet: unknown; jobs: Array<Record<string, unknown>>; tail?: unknown[]; thread?: string; sent?: unknown[] }) {
    const thread = options.thread ?? "task-1";
    const reads: URLSearchParams[] = [];
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/bots?messages=0") return options.fleet;
      if (path.startsWith(`/api/threads/${thread}/job?`)) {
        reads.push(new URLSearchParams(path.slice(path.indexOf("?") + 1)));
        return { since: 100, ...options.jobs[Math.min(reads.length - 1, options.jobs.length - 1)] };
      }
      if (path === `/api/threads/${thread}/messages?limit=10`) return { messages: options.tail ?? [] };
      if (path.endsWith("/messages") && init?.method === "POST") { options.sent?.push(JSON.parse(String(init.body))); return { ok: true }; }
      throw new Error(`unexpected path ${path}`);
    });
    return { fetcher, reads };
  }
  const bot = (patch: Record<string, unknown> = {}) => ({ bots: [{ id: "bot-1", name: "Mira", threadId: "task-1", busy: false, activity: "idle", tasks: [], ...patch }], groups: [] });

  it("asks again only with the version it saw, held by the server, until the job is done", async () => {
    const { fetcher, reads } = server({ fleet: bot(), tail: [{ id: "m1", at: 1, role: "bot", kind: "text", text: "Report ready" }], jobs: [
      { state: "running", version: "v1", reason: "Waiting on 2 teammate tasks: Priya, Marcus" },
      { state: "running", version: "v2", reason: "Waiting on 1 teammate task: Marcus" },
      { state: "completed", version: "v3", reason: "Mira finished" },
    ] });
    const progress: string[] = [];
    const result: any = await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 30 },
      fetcher, undefined, { onProgress: (job) => progress.push(job.reason) });
    expect(result).toMatchObject({ status: "settled", state: "completed", taskId: "task-1", messages: [{ text: "Report ready" }],
      job: { state: "completed", version: "v3" } });
    expect(progress).toEqual(["Waiting on 2 teammate tasks: Priya, Marcus", "Waiting on 1 teammate task: Marcus", "Mira finished"]);
    expect(reads.map((params) => Object.fromEntries(params))).toEqual([
      { scope: "job" },
      { scope: "job", since: "100", wait: expect.stringMatching(/^\d+$/), version: "v1" },
      { scope: "job", since: "100", wait: expect.stringMatching(/^\d+$/), version: "v2" },
    ]);
  });

  it("reports the person's turn, failures and stalls in the legacy words, with the job", async () => {
    const needs = server({ fleet: bot({ activity: "waiting-on-you" }), tail: [{ id: "m1", at: 1, role: "bot", kind: "text", text: "Approve?" }],
      jobs: [{ state: "needs-input", version: "v1", needsInput: [{ botName: "Priya", question: "Which tier?" }] }] });
    expect(await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, needs.fetcher))
      .toMatchObject({ status: "needs-user", state: "needs-input", messages: [{ text: "Approve?" }], job: { needsInput: [{ question: "Which tier?" }] } });
    for (const [activity, state] of [["dead", "failed"], ["no-signal", "stalled"]] as const) {
      const ended = server({ fleet: bot(), jobs: [{ state, version: "v1", conversation: { kind: "bot", busy: false, activity, queued: 0 } }] });
      expect(await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, ended.fetcher))
        .toMatchObject({ status: state, state });
    }
    const stopped = server({ fleet: bot(), tail: [{ id: "m1", at: 1, role: "bot", kind: "text", text: "Partial answer" }],
      jobs: [{ state: "failed", version: "v1", conversation: { kind: "bot", busy: false, activity: "idle", queued: 0 } }] });
    expect(await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, stopped.fetcher))
      .toMatchObject({ status: "settled", state: "failed" });
    const undispatched = server({ fleet: bot(), tail: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Go" },
      { id: "m2", at: 2, role: "bot", kind: "activity", tool: { name: "Error: could not start", ok: false, terminal: true } }],
    jobs: [{ state: "completed", version: "v1" }] });
    expect(await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, undispatched.fetcher))
      .toMatchObject({ status: "failed", state: "failed" });
    const idle = server({ fleet: bot(), jobs: [{ state: "idle", version: "v1" }] });
    expect(await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, idle.fetcher))
      .toMatchObject({ status: "settled", state: "idle" });
  });

  it("times out with the job as it stands", async () => {
    const { fetcher } = server({ fleet: bot({ busy: true }), jobs: [{ state: "running", version: "v1" }] });
    const result: any = await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, fetcher);
    expect(result).toMatchObject({ status: "timed-out", state: "timed-out", job: { state: "running" } });
  });

  it("waits past a state it was already told about, and keeps the job it was given", async () => {
    const { fetcher, reads } = server({ fleet: bot(), jobs: [{ state: "needs-input", version: "v1" }, { state: "running", version: "v2" }, { state: "completed", version: "v3" }] });
    const result: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", timeout_seconds: 30, since_ms: 42, after_version: "v1", scope: "turn",
    }, fetcher);
    expect(result).toMatchObject({ status: "settled", job: { version: "v3" } });
    expect(Object.fromEntries(reads[0]!)).toMatchObject({ scope: "turn", since: "42", version: "v1", wait: expect.any(String) });
  });

  it("reads what the transcript shows: an open card, or a dispatch that failed after the last message", async () => {
    const card = server({ fleet: { bots: [{ id: "bot-1", activity: "waiting-on-you" }],
      groups: [{ id: "channel-1", name: "Launch", memberIds: ["bot-1"], threadId: "task-1", tasks: [], busyBotId: "bot-1" }] },
      tail: [{ id: "m1", at: 1, role: "bot", kind: "options", card: { title: "Approve?", requestId: "private", allowKey: "Bash:git" } }],
      jobs: [{ state: "completed", version: "v1" }] });
    const waited: any = await handleToolCall("wait_for_conversation", { target_type: "channel", target_id: "channel-1", timeout_seconds: 1 }, card.fetcher);
    expect(waited.status).toBe("needs-user");
    expect(waited.messages[0].card).not.toHaveProperty("requestId");
    expect(waited.messages[0].card).not.toHaveProperty("allowKey");
    const failure = [
      { id: "u1", at: 1, role: "user", kind: "text", text: "Start" },
      { id: "e1", at: 2, role: "bot", kind: "activity", tool: { name: "error: provider failed to start", ok: false } },
    ];
    const failed = server({ fleet: bot(), tail: failure, jobs: [{ state: "completed", version: "v1" }] });
    expect(await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, failed.fetcher))
      .toMatchObject({ status: "failed" });
    for (const [terminal, status] of [[undefined, "settled"], [true, "failed"]] as const) {
      const tail = [{ id: "u1", at: 1, role: "user", kind: "text", text: "Create the file" },
        { id: "m1", at: 2, role: "bot", kind: "text", text: "The operation was denied." },
        { id: "e1", at: 3, role: "bot", kind: "activity", tool: { name: "error: A requested tool operation failed or was denied", ok: false, terminal } }];
      const answered = server({ fleet: bot(), tail, jobs: [{ state: "completed", version: "v1" }] });
      expect(await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 }, answered.fetcher))
        .toMatchObject({ status });
    }
  });

  it("reads a failed turn that left a quota-switch offer as failed: nothing waits on the offer", async () => {
    const failure = [
      { id: "u1", at: 1, role: "user", kind: "text", text: "Summarise the quarter" },
      { id: "e1", at: 2, role: "bot", kind: "activity", tool: { name: "error: This Claude account has reached its usage limit.", ok: false } },
    ];
    const wait = (card: Record<string, unknown>) => handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", timeout_seconds: 1 },
      server({ fleet: bot(), tail: [...failure, { id: "c1", at: 3, role: "bot", kind: "options", card }], jobs: [{ state: "completed", version: "v1" }] }).fetcher);
    const question = { title: "Which quarter?", subtitle: "", options: ["Q3", "Q4"], requestId: "r1" };
    expect(await wait(question)).toMatchObject({ status: "needs-user" });
    expect(await wait({
      ...question, title: "Claude is out of quota", options: ["Codex", "Not now"], fixedOptions: true,
      quotaSwitch: { engines: [{ instanceId: "codex", name: "Codex" }], messageId: "u1" },
    })).toMatchObject({ status: "failed" });
  });

  it("waits on a pinned task and projects the bot as it is at the end", async () => {
    let fleetReads = 0;
    const { fetcher } = server({ thread: "task-a", fleet: undefined, jobs: [{ state: "running", version: "v1" }, { state: "completed", version: "v2" }],
      tail: [{ role: "bot", kind: "text", text: "A done" }] });
    const wrapped = vi.fn(async (path: string, init?: RequestInit) => {
      if (path !== "/api/bots?messages=0") return fetcher(path, init);
      fleetReads += 1;
      return { bots: [{ id: "bot-1", threadId: fleetReads === 1 ? "task-a" : "task-b", busy: true, activity: "working",
        tasks: [{ threadId: "task-a", busy: fleetReads === 1 }, { threadId: "task-b", busy: true }] }], groups: [] };
    });
    const result: any = await handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", task_id: "task-a", timeout_seconds: 30 }, wrapped);
    expect(result).toMatchObject({ status: "settled", taskId: "task-a", messages: [{ text: "A done" }], target: { activeTaskId: "task-b", busy: true } });
    await expect(handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1", task_id: "not-owned" }, wrapped))
      .rejects.toThrow("does not belong");
  });

  it("names an older server that cannot report a job, and a conversation that is gone as gone", async () => {
    const answering = (body: string) => vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return bot();
      throw new OpenMausBotApiError(404, `OpenMausBot API error (404): ${body}`);
    });
    await expect(handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1" }, answering("not found")))
      .rejects.toThrow("cannot report a conversation's job");
    await expect(handleToolCall("wait_for_conversation", { target_type: "bot", target_id: "bot-1" }, answering('{"error":"no such conversation"}')))
      .rejects.toThrow('OpenMausBot API error (404): {"error":"no such conversation"}');
  });

  it("sends with the caller's send id, returns the receipt, and refuses a malformed id before sending", async () => {
    const sent: unknown[] = [];
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/bots?messages=0") return { bots: [{ id: "bot-1", threadId: "task-1", tasks: [] }],
        groups: [{ id: "channel-1", threadId: "room-1", tasks: [{ threadId: "room-1", working: true }] }] };
      sent.push(JSON.parse(String(init?.body)));
      return path.startsWith("/api/bots/")
        ? { ok: true, threadId: "task-1", message: { id: "msg-1", at: 1234, text: "Go" } }
        : { ok: true, queued: true, queueId: "q-1", threadId: "room-1" };
    });
    expect(await handleToolCall("send_bot_message", { bot_id: "bot-1", text: "Go", send_id: "run-0123456789abcdef" }, fetcher))
      .toEqual({ success: true, botId: "bot-1", taskId: "task-1", messageId: "msg-1", at: 1234 });
    expect(await handleToolCall("send_channel_message", { channel_id: "channel-1", text: "Go", send_id: "run-0123456789abcdef" }, fetcher))
      .toEqual({ success: true, channelId: "channel-1", taskId: "room-1", queued: true, queueId: "q-1" });
    expect(sent).toEqual([{ text: "Go", threadId: "task-1", sendId: "run-0123456789abcdef" }, { text: "Go", threadId: "room-1", sendId: "run-0123456789abcdef" }]);
    await expect(handleToolCall("send_bot_message", { bot_id: "bot-1", text: "Go", send_id: "short" }, fetcher)).rejects.toThrow("send_id must be");
    expect(sent).toHaveLength(2);
  });

  it("sends a channel message with the ids of the bots it means when two share a name", async () => {
    const sent: unknown[] = [];
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/bots?messages=0") return { bots: [], groups: [{ id: "channel-1", threadId: "room-1", tasks: [] }] };
      sent.push(JSON.parse(String(init?.body)));
      return { ok: true, threadId: "room-1", message: { id: "msg-1", at: 1, text: "@Quill go" } };
    });
    await handleToolCall("send_channel_message", { channel_id: "channel-1", text: "@Quill go", mentions: ["quill-chief"] }, fetcher);
    expect(sent).toEqual([{ text: "@Quill go", threadId: "room-1", mentions: ["quill-chief"] }]);
    await expect(handleToolCall("send_channel_message", { channel_id: "channel-1", text: "@Quill go", mentions: "quill-chief" }, fetcher))
      .rejects.toThrow("arguments.mentions must be array");
  });
});

describe("connection security and discovery", () => {
  it("accepts loopback HTTP and HTTPS origins, but rejects unsafe URL shapes", () => {
    expect(validateBaseUrl("http://127.0.0.1:8799/")).toBe("http://127.0.0.1:8799");
    expect(validateBaseUrl("http://[::1]:8799")).toBe("http://[::1]:8799");
    expect(validateBaseUrl("https://maus.example.com")).toBe("https://maus.example.com");
    expect(() => validateBaseUrl("ftp://maus.example.com")).toThrow("http:// or https://");
    expect(() => validateBaseUrl("https://maus.example.com/api")).toThrow("origin without a path");
    expect(() => validateBaseUrl("https://user:pass@maus.example.com")).toThrow("must not contain credentials");
    expect(() => validateBaseUrl("http://0.0.0.0:8799")).toThrow("Insecure cleartext HTTP");
  });

  it("skips a foreign process and discovers the real fallback port", async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes(":8799")) return jsonResponse({ app: "not-openmausbot" });
      if (String(url).includes(":18799")) return jsonResponse({ app: "openmausbot" });
      throw new Error("unexpected port");
    }) as any;
    await expect(probeBaseUrls(["http://127.0.0.1:8799", "http://127.0.0.1:18799"])).resolves.toBe("http://127.0.0.1:18799");
  });

  it("rejects successful non-JSON responses and sends an optional bearer token", async () => {
    process.env.OPENMAUSBOT_TOKEN = "proxy-token";
    globalThis.fetch = vi.fn(async (_url: any, options: any) => {
      expect(new Headers(options.headers).get("Authorization")).toBe("Bearer proxy-token");
      return { ...jsonResponse({}), json: vi.fn(async () => { throw new Error("not json"); }) };
    }) as any;
    await expect(request("/api/health", {}, "https://maus.example.com")).rejects.toThrow("non-JSON response");
  });

  it("explains how to authorize packaged write refusals", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(
      { error: "desktop owner capability required" },
      { ok: false, status: 403, statusText: "Forbidden" },
    )) as any;
    await expect(request("/api/bots/bot-1/messages", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    }, "http://127.0.0.1:8799")).rejects.toThrow("paired session token");
  });

  it("requires an explicit destination before sending a bearer token", async () => {
    process.env.OPENMAUSBOT_TOKEN = "proxy-token";
    await expect(resolveBaseUrl()).rejects.toThrow("OPENMAUSBOT_URL or OMB_PORT");
  });

  it("validates direct tool arguments", () => {
    expect(() => validateToolArguments("send_bot_message", { bot_id: "bot-1", text: "hello" })).not.toThrow();
    expect(() => validateToolArguments("send_bot_message", { bot_id: "bot-1", text: "hello", extra: true })).toThrow("not supported");
  });
});
