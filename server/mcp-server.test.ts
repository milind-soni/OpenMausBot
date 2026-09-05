import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleToolCall,
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
          threadId: "task-1", messages: [], tasks: [{ threadId: "task-1", title: "Case", createdAt: 10 }],
        }],
      };
    });
    const result: any = await handleToolCall("list_bots", {}, fetcher);
    expect(result.bots[0]).toMatchObject({ id: "bot-1", activeTaskId: "task-1", activity: "idle" });
    expect(result.bots[0].tasks[0]).toMatchObject({ taskId: "task-1", active: true });
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

  it("pins bot and channel sends to the active task", async () => {
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
        expect(JSON.parse(String(options?.body))).toEqual({ text: "Investigate", threadId: "bot-task" });
        return { ok: true };
      }
      if (path === "/api/groups/channel-1/messages") {
        expect(JSON.parse(String(options?.body))).toEqual({ text: "Ship it", threadId: "channel-task" });
        return { ok: true };
      }
      throw new Error(`unexpected path ${path}`);
    });

    await expect(handleToolCall("send_bot_message", {
      bot_id: "bot-1", task_id: "bot-old", text: "Wrong task",
    }, fetcher)).rejects.toThrow("not active");
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

  it("waits on a bot conversation and returns a compact attention tail", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Mira", busy: true, activity: "waiting-on-you", threadId: "task-1", tasks: [] }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return { messages: [{ id: "m1", at: 1, role: "bot", kind: "text", text: "Approve?" }] };
      throw new Error(`unexpected path ${path}`);
    });
    const result: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", timeout_seconds: 1,
    }, fetcher);
    expect(result).toMatchObject({ status: "needs-user", messages: [{ text: "Approve?" }] });
  });

  it("reports no-signal as stalled and keeps the frozen task tail", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{
          id: "bot-1", name: "Mira", busy: true, activity: "no-signal",
          threadId: "task-active", tasks: [{ threadId: "task-active" }, { threadId: "task-old" }],
        }],
        groups: [],
      };
      if (path === "/api/threads/task-old/messages?limit=10") {
        return { messages: [{ id: "old", at: 1, role: "bot", kind: "text", text: "Old task" }] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const historical: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", task_id: "task-old", timeout_seconds: 1,
    }, fetcher);
    expect(historical).toMatchObject({ status: "settled", taskId: "task-old", messages: [{ text: "Old task" }] });

    const stalledFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Mira", busy: true, activity: "no-signal", threadId: "task-active", tasks: [] }],
        groups: [],
      };
      if (path === "/api/threads/task-active/messages?limit=10") return { messages: [] };
      throw new Error(`unexpected path ${path}`);
    });
    const stalled: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", timeout_seconds: 1,
    }, stalledFetcher);
    expect(stalled.status).toBe("stalled");
  });

  it("reports asynchronous bot and channel dispatch failures", async () => {
    const errorMessages = {
      messages: [
        { id: "u1", at: 1, role: "user", kind: "text", text: "Start" },
        { id: "e1", at: 2, role: "bot", kind: "activity", tool: { name: "error: provider failed to start", ok: false } },
      ],
    };
    const botFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", name: "Mira", busy: false, activity: "idle", threadId: "task-1", tasks: [] }],
        groups: [],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return errorMessages;
      throw new Error(`unexpected path ${path}`);
    });
    const botResult: any = await handleToolCall("wait_for_conversation", {
      target_type: "bot", target_id: "bot-1", timeout_seconds: 1,
    }, botFetcher);
    expect(botResult.status).toBe("failed");

    const channelFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [],
        groups: [{
          id: "channel-1", name: "Launch", memberIds: [], threadId: "task-1",
          tasks: [], working: false, busyBotId: null,
        }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return errorMessages;
      throw new Error(`unexpected path ${path}`);
    });
    const channelResult: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, channelFetcher);
    expect(channelResult.status).toBe("failed");

    const partialFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") return {
        bots: [],
        groups: [{
          id: "channel-1", name: "Launch", memberIds: [], threadId: "task-1",
          tasks: [], working: false, busyBotId: null,
        }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return {
        messages: [
          ...errorMessages.messages,
          { id: "m2", at: 3, role: "bot", kind: "text", text: "Another responder completed the task." },
        ],
      };
      throw new Error(`unexpected path ${path}`);
    });
    const partialResult: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, partialFetcher);
    expect(partialResult.status).toBe("settled");
  });

  it("detects durable channel blockers and interrupts the exact target thread", async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots?messages=0") return {
        bots: [{ id: "bot-1", activity: "waiting-on-you" }],
        groups: [{ id: "channel-1", name: "Launch", memberIds: ["bot-1"], threadId: "task-1", tasks: [], busyBotId: "bot-1" }],
      };
      if (path === "/api/threads/task-1/messages?limit=10") return {
        messages: [{ id: "m1", at: 1, role: "bot", kind: "options", card: { title: "Approve?", requestId: "private", allowKey: "Bash:git" } }],
      };
      if (path === "/api/groups/channel-1/interrupt") {
        expect(JSON.parse(String(options?.body))).toEqual({ threadId: "task-1" });
        return { ok: true };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const waited: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, fetcher);
    expect(waited.status).toBe("needs-user");
    expect(waited.messages[0].card).not.toHaveProperty("requestId");
    expect(waited.messages[0].card).not.toHaveProperty("allowKey");

    const interrupted: any = await handleToolCall("interrupt_conversation", {
      target_type: "channel", target_id: "channel-1",
    }, fetcher);
    expect(interrupted).toEqual({
      success: true, targetType: "channel", targetId: "channel-1", taskId: "task-1",
    });
  });

  it("keeps waiting while a channel operation is between responders", async () => {
    let fleetReads = 0;
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=0") {
        fleetReads += 1;
        return {
          bots: [],
          groups: [{
            id: "channel-1",
            name: "Launch",
            memberIds: ["bot-1", "bot-2"],
            threadId: "task-1",
            tasks: [],
            working: fleetReads === 1,
            busyBotId: null,
          }],
        };
      }
      if (path === "/api/threads/task-1/messages?limit=10") return {
        messages: fleetReads === 1
          ? [{ id: "m1", at: 1, role: "user", kind: "text", text: "Ask everyone" }]
          : [{ id: "m2", at: 2, role: "bot", kind: "text", text: "Done" }],
      };
      throw new Error(`unexpected path ${path}`);
    });

    const result: any = await handleToolCall("wait_for_conversation", {
      target_type: "channel", target_id: "channel-1", timeout_seconds: 1,
    }, fetcher);
    expect(fleetReads).toBe(2);
    expect(result).toMatchObject({ status: "settled", target: { working: false } });
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
