import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { agentsMcp, agentsToolList } from "./agents-mcp.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";

const names = (env: NodeJS.ProcessEnv) => agentsToolList(env).listed.map(tool => tool.name);

describe("configured search availability", () => {
  it("requires the harness switch and does not depend on paid research", () => {
    expect(names({})).not.toContain("web_search");
    expect(names({ OMB_WEB_SEARCH: "1" })).toContain("web_search");
    expect(names({ OMB_X_RESEARCH: "1" })).not.toContain("web_search");
  });

  it.each([OpenAICompatDriver, PiDriver])("marks $driverKind as needing search", async driver => {
    const input = { instanceId: "search-fixture", displayName: "Search fixture", enabled: true, environment: {} };
    const instance = await (driver === OpenAICompatDriver ? OpenAICompatDriver.create({ ...input, config: OpenAICompatDriver.defaultConfig() }) : PiDriver.create({ ...input, config: PiDriver.defaultConfig() }));
    try {
      expect(instance.adapter.capabilities).toMatchObject({ webSearch: true });
    } finally {
      await instance.dispose();
    }
  });
});


describe("web search through the agents MCP", () => {
  it("sends the capability and arguments to the harness and preserves failures", async () => {
    const calls: unknown[] = [];
    let status = 200;
    const server = createServer((req, res) => {
      if (req.url === "/api/internal/tool-timing") { res.end("{}"); return; }
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 200 ? { untrusted: true, results: [{ title: "Fixture", url: "https://example.com/", snippet: "Source" }] } : { error: "Search is blocked." }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const handle = agentsMcp({ OMB_WEB_SEARCH: "1", OMB_HARNESS_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, OMB_COMMS_TOKEN: "synthetic-search-capability" });
      const call = (args: Record<string, unknown>) => handle({ id: 1, method: "tools/call", params: { name: "web_search", arguments: args } });
      const answer = await call({ query: "fixture", limit: 1 });
      expect(answer).toMatchObject({ result: { isError: false, content: [{ type: "text", text: expect.stringContaining('"untrusted":true') }] } });
      expect(calls).toEqual([{ path: "/api/internal/web/search", authorization: "Bearer synthetic-search-capability", body: { query: "fixture", limit: 1 } }]);
      status = 502;
      expect(await call({ query: "fixture" })).toMatchObject({ result: { isError: true, content: [{ text: "Search is blocked." }] } });
      expect(await call({ query: "fixture", limit: 11 })).toMatchObject({ result: { isError: true } });
      expect(calls).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
