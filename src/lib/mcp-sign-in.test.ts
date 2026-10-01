import { describe, expect, it, vi } from "vitest";

import { completeMcpSignIn, mcpSignInLink, runMcpSignIn } from "./mcp-sign-in";

const waiting = { phase: "waiting", flowId: "11111111-2222-3333-4444-555555555555", authorizationUrl: "https://clerk.higgsfield.ai/oauth/authorize?client_id=x", expiresAt: "2026-09-30T12:00:00Z" };

function stubApi(statuses: unknown[]) {
  const calls: Array<[string, string]> = [];
  const api = vi.fn(async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push([method, path]);
    if (method === "POST") return { auth: waiting };
    if (method === "DELETE") return { ok: true };
    const next = statuses.shift();
    if (next instanceof Error) throw next;
    return { auth: next };
  });
  return { api, calls };
}

describe("mcpSignInLink", () => {
  it("accepts only https sign-in pages", () => {
    expect(mcpSignInLink(waiting.authorizationUrl)).toBe(waiting.authorizationUrl);
    expect(mcpSignInLink("http://evil.example.com/login")).toBeNull();
    expect(mcpSignInLink("javascript:alert(1)")).toBeNull();
    expect(mcpSignInLink("https://user:pw@example.com/")).toBeNull();
    expect(mcpSignInLink(null)).toBeNull();
  });
});

describe("runMcpSignIn", () => {
  it("opens the sign-in page and waits for the result", async () => {
    const { api, calls } = stubApi([{ ...waiting }, { ...waiting, phase: "succeeded", authorizationUrl: null }]);
    const open = vi.fn(async () => {});
    const result = await runMcpSignIn("hf", { api, open, sleep: async () => {} });
    expect(open).toHaveBeenCalledWith(waiting.authorizationUrl);
    expect(result.phase).toBe("succeeded");
    expect(calls).toEqual([
      ["POST", "/api/mcp/servers/hf/sign-in"],
      ["GET", `/api/mcp/servers/hf/sign-in/${waiting.flowId}`],
      ["GET", `/api/mcp/servers/hf/sign-in/${waiting.flowId}`],
    ]);
  });

  it("refuses a sign-in page that is not https and cancels the flow", async () => {
    const { calls } = stubApi([]);
    const api = vi.fn(async (path: string, init?: { method?: string }) => {
      calls.push([init?.method ?? "GET", path]);
      return init?.method === "POST" ? { auth: { ...waiting, authorizationUrl: "http://evil.example.com/" } } : { ok: true };
    });
    const open = vi.fn(async () => {});
    const result = await runMcpSignIn("hf", { api, open, sleep: async () => {} });
    expect(open).not.toHaveBeenCalled();
    expect(result.phase).toBe("failed");
    expect(calls).toContainEqual(["DELETE", `/api/mcp/servers/hf/sign-in/${waiting.flowId}`]);
  });

  it("cancels on the server when the person cancels", async () => {
    const { api, calls } = stubApi([{ ...waiting }, { ...waiting }]);
    const controller = new AbortController();
    const result = await runMcpSignIn("hf", {
      api,
      open: async () => {},
      sleep: async () => { controller.abort(); },
      signal: controller.signal,
    });
    expect(result.phase).toBe("cancelled");
    expect(calls).toContainEqual(["DELETE", `/api/mcp/servers/hf/sign-in/${waiting.flowId}`]);
  });

  it("treats a vanished flow as expired", async () => {
    const { api } = stubApi([new Error("This sign-in is no longer available. Start again.")]);
    const result = await runMcpSignIn("hf", { api, open: async () => {}, sleep: async () => {} });
    expect(result).toMatchObject({ phase: "expired" });
  });
});


it("exposes the pending flow for paste-back even if opening the browser fails", async () => {
  const { api } = stubApi([{ ...waiting, phase: "succeeded" }]);
  const onStarted = vi.fn();
  const result = await runMcpSignIn("hf", { api, onStarted, open: async () => { throw new Error("blocked"); }, sleep: async () => {} });
  expect(onStarted).toHaveBeenCalledWith(waiting, expect.any(Function));
  expect(result.phase).toBe("succeeded");
});

it("cancels an attempt aborted while the start request was pending without opening it", async () => {
  const { api, calls } = stubApi([]);
  const controller = new AbortController();
  controller.abort();
  const open = vi.fn();
  const result = await runMcpSignIn("hf", { api, open, signal: controller.signal });
  expect(result.phase).toBe("cancelled");
  expect(open).not.toHaveBeenCalled();
  expect(calls).toContainEqual(["DELETE", `/api/mcp/servers/hf/sign-in/${waiting.flowId}`]);
});

it("submits a pasted URL only in the completion body for the selected flow", async () => {
  const callback = "http://127.0.0.1:23456/mcp-oauth/callback?code=private&state=private";
  const api = vi.fn(async () => ({ auth: { ...waiting, phase: "succeeded", authorizationUrl: null } }));
  expect((await completeMcpSignIn("hf", waiting.flowId, ` ${callback} `, api)).phase).toBe("succeeded");
  expect(api).toHaveBeenCalledWith(`/api/mcp/servers/hf/sign-in/${waiting.flowId}`, { method: "POST", body: JSON.stringify({ callbackUrl: callback }) });
});

it.each(["succeeded", "failed"] as const)("shows a pasted %s result without waiting for a status poll", async (phase) => {
  const { api, calls } = stubApi([]);
  const result = await runMcpSignIn("hf", {
    api, open: async () => {}, sleep: () => new Promise<void>(() => {}),
    onStarted: (_status, complete) => complete({ ...waiting, phase, authorizationUrl: null, message: "Provider result" }),
  });
  expect(result).toMatchObject({ phase, message: "Provider result" });
  expect(calls).toEqual([["POST", "/api/mcp/servers/hf/sign-in"]]);
});

it("keeps cancellation when a pasted completion resolves at the same time", async () => {
  const { api, calls } = stubApi([]);
  const controller = new AbortController();
  const result = await runMcpSignIn("hf", {
    api, signal: controller.signal, open: async () => {},
    sleep: () => new Promise<void>(() => {}),
    onStarted: (_status, complete) => {
      complete({ ...waiting, phase: "succeeded", authorizationUrl: null });
      controller.abort();
    },
  });
  expect(result.phase).toBe("cancelled");
  expect(calls.filter(([method]) => method === "DELETE")).toEqual([
    ["DELETE", `/api/mcp/servers/hf/sign-in/${waiting.flowId}`],
  ]);
});

it.each(["open", "poll"] as const)("cancels immediately while %s remains pending", async (pending) => {
  const controller = new AbortController();
  let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const { api, calls } = stubApi([]);
  const request = pending === "poll"
    ? vi.fn(async (path: string, init?: { method?: string }) => {
        if (!init?.method) { reached(); return new Promise(() => {}); }
        return api(path, init);
      })
    : api;
  const result = runMcpSignIn("hf", {
    api: request, signal: controller.signal,
    open: () => { if (pending === "open") { reached(); return new Promise<void>(() => {}); } return Promise.resolve(); },
    sleep: async () => {},
  });
  await ready;
  controller.abort();
  expect((await result).phase).toBe("cancelled");
  expect(calls).toContainEqual(["DELETE", `/api/mcp/servers/hf/sign-in/${waiting.flowId}`]);
});
