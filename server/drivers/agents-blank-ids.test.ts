import { describe, expect, it } from "vitest";

import { agentsCallIdentities, agentsCallMember, resolveAgentsCall } from "../../shared/agents-tool-names.ts";
import { parseShowHtmlInput, parseUpdateHtmlInput } from "../../shared/app.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { WIDGET_SAMPLES } from "../../shared/widget-samples.ts";

import { callTool, type ToolCallContext } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

async function run(name: string, args: Json, answer: Json = { ok: true, messageId: "m1" }) {
  const sent: Array<{ path: string; body?: Json }> = [];
  const client: ToolCallContext["client"] = {
    api: async (path, init) => {
      sent.push({ path, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as Json }) });
      return answer;
    },
    apiResponse: async (path, init) => ({ ok: true, status: 200, body: await client.api(path, init) }),
  };
  const result = await callTool(name, args, {
    botId: "bot-blank", threadId: "thread-blank", depth: 0, externalRuntime: false, sharedComputers: true, client,
  });
  return { result, sent };
}

/** Each tool that does two things, the id that decides which, and a call that carries no id at all. */
const ROUTES = [
  { name: "session_search", update: "session_read", key: "thread_id", args: { query: "site audit" } },
  { name: "show_html", update: "update_html", key: "app_id", args: { html: "<h1>test</h1>", title: "Test" } },
  { name: "show_widget", update: "update_widget", key: "widget_id", args: { widget: WIDGET_SAMPLES.buildStatus } },
];

describe("a blank id asks for the plain operation", () => {
  it.each(ROUTES)("$name with a blank $key makes instead of updating", async ({ name, update, key, args }) => {
    for (const blank of ["", " \t "]) {
      const input = { ...args, [key]: blank };
      expect(agentsCallMember(name, input)).toBe(name);
      const resolved = resolveAgentsCall(name, input);
      expect(resolved.name).toBe(name);
      expect(agentsCallMember(resolved.name, resolved.arguments)).toBe(name);
      expect(agentsCallIdentities(name, input)).toEqual([[name]]);
      // An "always allow" saved for the plain tool must cover this call; one saved for the update must not.
      const tool = { kind: "mcp" as const, server: "agents", name };
      expect(allowsTool({ allow: [`mcp:agents:${name}`] }, tool, input)).toBe(true);
      expect(allowsTool({ allow: [`mcp:agents:${update}`] }, tool, input)).toBe(false);

      const { result, sent } = await run(name, input);
      expect(result.isError).toBeFalsy();
      expect(sent).toHaveLength(1);
      if (name === "session_search") expect(sent[0]!.path).toMatch(/^\/api\/internal\/session-search\?/);
      else expect(sent[0]!.body).not.toHaveProperty(key);
    }
  });

  it.each(ROUTES)("$update without an id still refuses before any request", async ({ update, key, args }) => {
    for (const input of [args, { ...args, [key]: "" }, { ...args, [key]: "  " }]) {
      const { result, sent } = await run(update, input);
      expect(result.isError).toBe(true);
      expect(sent).toEqual([]);
    }
  });
});

describe("a non-text id is not read as a name", () => {
  it.each([false, 0, ["thread-1"], { id: "thread-1" }])("refuses %j rather than reading a message from it", async (thread_id) => {
    const { result, sent } = await run("session_read", { thread_id, message_id: "m1" });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("needs both thread_id and message_id") });
    expect(sent).toEqual([]);
  });

  it("keeps a half-filled read a refusal", async () => {
    const { result, sent } = await run("session_search", { query: "audit", thread_id: "thread-old", message_id: "" });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("needs both thread_id and message_id") });
    expect(sent).toEqual([]);
  });
});

describe("a blank page source does not compete with the one that carries content", () => {
  const sources = [
    { html: "<h1>test</h1>", jsx: "", path: "" },
    { html: "", jsx: "export default function Test() { return <h1>test</h1>; }", path: " \t" },
    { html: " ", jsx: "", path: "page.html" },
  ];

  it.each(sources)("accepts %j for both a new page and a replaced one", async (source) => {
    expect(parseShowHtmlInput({ ...source, title: "Test" })).toMatchObject({ ok: true });
    expect(parseUpdateHtmlInput({ ...source, app_id: "m1" })).toMatchObject({ ok: true });
    const { result, sent } = await run("show_html", { ...source, title: "Test" });
    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toHaveProperty("app_id");
  });

  it("still refuses missing content and two sources that both carry some", () => {
    for (const source of [
      { html: "", jsx: "", path: "" },
      { html: " ", jsx: " \t", path: "" },
      { html: "<p>one</p>", jsx: "export default 1" },
      { html: "<p>one</p>", path: 0 },
    ]) {
      expect(parseShowHtmlInput({ ...source, title: "Test" }).ok).toBe(false);
    }
    expect(parseUpdateHtmlInput({ html: "<p>one</p>", jsx: "", path: "" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^app_id:/),
    });
  });
});
