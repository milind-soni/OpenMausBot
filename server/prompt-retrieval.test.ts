import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  appendPromptRetrievalContext,
  normalizeRepositoryRemote,
  promptRetrievalConfiguration,
  retrievePromptContext,
} from "./prompt-retrieval.ts";

const CONTEXT = [
  '<fleet-retrieval-evidence trust="untrusted" instruction-authority="false">',
  '{"hits":[]}',
  "</fleet-retrieval-evidence>",
].join("\n");

interface ResponseOverrides {
  schema?: string;
  status?: string;
  surface?: string;
  interface?: string;
  context?: string;
  content_trust?: string;
  instruction_authority?: boolean;
  tool_authority?: boolean;
  write_authority?: boolean;
  selector_authority?: boolean;
  promotion_authority?: boolean;
  prompt_or_content_recorded_by_adapter?: boolean;
  native_event?: string;
  native_event_id?: string;
  session_key_hash?: string;
  request_kind?: string;
  source_marker?: string;
}

function response(overrides: ResponseOverrides = {}): Response {
  return new Response(JSON.stringify({
    schema: "aos.openmausbot-retrieval-adapter.v1",
    status: "context_ready",
    surface: "openmausbot",
    interface: "loopback",
    context: CONTEXT,
    content_trust: "untrusted_retrieval_evidence",
    instruction_authority: false,
    tool_authority: false,
    write_authority: false,
    selector_authority: false,
    promotion_authority: false,
    prompt_or_content_recorded_by_adapter: false,
    native_event: "pre_llm_call",
    native_event_id: "openmaus-message-1",
    session_key_hash: createHash("sha256").update("openmaus-thread-1").digest("hex"),
    request_kind: "user_task",
    source_marker: "openmausbot-native-v1",
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("guarded OpenMaus prompt retrieval", () => {
  it("reports the immutable native hook and only a valid loopback endpoint as configured", () => {
    expect(promptRetrievalConfiguration("")).toEqual({
      configured: false,
      interface: "loopback",
      endpoint: null,
      native_event: "pre_llm_call",
      source_marker: "openmausbot-native-v1",
      context_ceiling_bytes: 768,
    });
    expect(promptRetrievalConfiguration("http://127.0.0.1:8798")).toMatchObject({
      configured: true,
      endpoint: "http://127.0.0.1:8798/v1/retrieve",
      native_event: "pre_llm_call",
      context_ceiling_bytes: 768,
    });
    expect(promptRetrievalConfiguration("https://127.0.0.1:8798").configured).toBe(false);
  });

  it("stays disabled without an explicit loopback endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await retrievePromptContext("find source", "thread-1", {
      endpoint: "",
      fetchImpl,
    })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1:8798",
    "http://192.168.1.2:8798",
    "http://user@127.0.0.1:8798",
    "http://127.0.0.1:8798/other",
  ])("rejects a non-loopback or ambiguous endpoint: %s", async (endpoint) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await retrievePromptContext("find source", "thread-1", {
      endpoint,
      fetchImpl,
    })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes the native project identity without retaining it in the transcript", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    const repositoryRemoteResolver = vi.fn().mockResolvedValue(
      "lightcloud00/claudecode-workspace",
    );
    const context = await retrievePromptContext(
      "Find the exact implementation",
      "openmaus-thread-1",
      {
        cwd: "D:\\AOSCanaries\\claudecode-workspace",
        endpoint: "http://127.0.0.1:8798",
        eventId: "openmaus-message-1",
        fetchImpl,
        requestKind: "user_task",
        repositoryRemoteResolver,
      },
    );

    expect(context).toBe(CONTEXT);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8798/v1/retrieve");
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: "Find the exact implementation",
      session_id: "openmaus-thread-1",
      cwd: "D:\\AOSCanaries\\claudecode-workspace",
      native_event: "pre_llm_call",
      native_event_id: "openmaus-message-1",
      repository_remote: "lightcloud00/claudecode-workspace",
      request_kind: "user_task",
      source_marker: "openmausbot-native-v1",
    });
    expect(repositoryRemoteResolver).toHaveBeenCalledWith(
      "D:\\AOSCanaries\\claudecode-workspace",
    );
    expect(init?.cache).toBe("no-store");
    expect(appendPromptRetrievalContext("user text", context)).toBe(
      `user text\n\n${CONTEXT}`,
    );
  });

  it.each([
    ["lightcloud00/claudecode-workspace", "lightcloud00/claudecode-workspace"],
    ["https://github.com/lightcloud00/claudecode-workspace.git", "lightcloud00/claudecode-workspace"],
    ["git@github.com:lightcloud00/claudecode-workspace.git", "lightcloud00/claudecode-workspace"],
    ["ssh://git@github.com/lightcloud00/claudecode-workspace", "lightcloud00/claudecode-workspace"],
  ])("normalizes a stable repository identity from %s", (remote, expected) => {
    expect(normalizeRepositoryRemote(remote)).toBe(expected);
  });

  it.each([
    "https://gitlab.com/lightcloud00/claudecode-workspace.git",
    "github.com/lightcloud00/claudecode-workspace/extra",
    "claudecode-workspace",
  ])("rejects a non-authoritative repository remote %s", (remote) => {
    expect(normalizeRepositoryRemote(remote)).toBeNull();
  });

  it.each([
    { instruction_authority: true },
    { tool_authority: true },
    { write_authority: true },
    { selector_authority: true },
    { promotion_authority: true },
    { prompt_or_content_recorded_by_adapter: true },
    { native_event_id: "another-message" },
    { session_key_hash: "0".repeat(64) },
    { request_kind: "automation" },
    { context: "unwrapped" },
  ])("drops an unsafe adapter response: %j", async (unsafe) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(unsafe));
    expect(await retrievePromptContext("find source", "thread-1", {
      endpoint: "http://localhost:8798/v1/retrieve",
      eventId: "openmaus-message-1",
      fetchImpl,
      requestKind: "user_task",
    })).toBeNull();
  });

  it("fails open on transport errors and oversize prompts", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    expect(await retrievePromptContext("find source", "thread-1", {
      endpoint: "http://127.0.0.1:8798",
      eventId: "openmaus-message-1",
      fetchImpl,
      requestKind: "user_task",
    })).toBeNull();
    expect(await retrievePromptContext("x".repeat(8_193), "thread-1", {
      endpoint: "http://127.0.0.1:8798",
      eventId: "openmaus-message-1",
      fetchImpl,
      requestKind: "user_task",
    })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("requires a bounded native event id and explicit request kind", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(await retrievePromptContext("find source", "thread-1", {
      endpoint: "http://127.0.0.1:8798", fetchImpl,
    })).toBeNull();
    expect(await retrievePromptContext("find source", "thread-1", {
      endpoint: "http://127.0.0.1:8798",
      eventId: "invalid event id", fetchImpl, requestKind: "user_task",
    })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
