import { describe, expect, it, vi } from "vitest";

import { mcpSignInLink, runMcpSignIn } from "./mcp-sign-in";

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
    expect(calls).toContainEqual(["DELETE", "/api/mcp/servers/hf/sign-in"]);
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
    expect(calls).toContainEqual(["DELETE", "/api/mcp/servers/hf/sign-in"]);
  });

  it("treats a vanished flow as expired", async () => {
    const { api } = stubApi([new Error("This sign-in is no longer available. Start again.")]);
    const result = await runMcpSignIn("hf", { api, open: async () => {}, sleep: async () => {} });
    expect(result).toMatchObject({ phase: "expired" });
  });
});
