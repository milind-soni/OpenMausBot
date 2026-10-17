import { afterEach, expect, it, vi } from "vitest";
import { localTokenizerUrl, measureChatRequests } from "./measure-chat-tokens.ts";

afterEach(() => vi.unstubAllGlobals());

it("restricts tokenizer requests to unauthenticated loopback endpoints", () => {
  for (const value of ["https://remote.example", "http://127.0.0.1.evil", "http://user:key@localhost:1234", "http://localhost:1234/complete", "http://localhost:1234?key=secret"]) {
    expect(() => localTokenizerUrl(value)).toThrow();
  }
  expect(localTokenizerUrl("http://127.0.0.1:18981/v1").href).toBe("http://127.0.0.1:18981/");
});

it("renders full tool-bearing requests and measures token prefix reuse without inference", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  let index = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
    expect(init.redirect).toBe("error");
    return new Response(JSON.stringify(url.pathname === "/apply-template"
      ? { prompt: `rendered-${index}` }
      : { tokens: index++ ? [11, 12, 13, 15, 16] : [11, 12, 13, 14] }));
  }));
  const tools = [{ type: "function", function: { name: "fixture", parameters: { type: "object" } } }];
  const report = await measureChatRequests([
    { model: "fake-provider-model", messages: [{ role: "user", content: "hello" }], tools },
    { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }], tools },
  ], localTokenizerUrl("http://localhost:1234"));
  expect(calls.map((call) => call.path)).toEqual(["/apply-template", "/tokenize", "/apply-template", "/tokenize"]);
  expect(calls[0].body.tools).toEqual(tools);
  expect(calls[0].body).not.toHaveProperty("model");
  expect(calls[1].body).toEqual({ content: "rendered-0", add_special: false });
  expect(report.measurements[1]).toMatchObject({ inputTokens: 5, sharedPrefixTokens: 3, previousInputTokens: 4, newSuffixTokens: 2, toolCount: 1 });
  expect(JSON.stringify(report)).not.toContain("hello");
});
