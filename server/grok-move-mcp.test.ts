import { describe, expect, it } from "vitest";

import { GROK_EXPORT_FORMAT, GROK_EXPORT_MAX_CHARS, parseGrokExport } from "../shared/grok-import.ts";
import { createMoveInbox, MOVE_MAX_BYTES, MOVE_MAX_DOCUMENTS, moveMcp, type MoveLink } from "./grok-move-mcp.ts";

const TOKEN = "sk-abcdefghijklmnopqrstuvwx";
const EXPIRES = Date.UTC(2030, 0, 1);
const link = (): MoveLink => {
  let seq = 0;
  return { inbox: createMoveInbox(() => ++seq), expiresAt: EXPIRES };
};
const document = (name: string, extra: Record<string, unknown> = {}) => ({ format: GROK_EXPORT_FORMAT, version: 1, bots: [{ name, ...extra }] });
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });
const call = (to: MoveLink, name: string, args: unknown = {}) => {
  const answer = moveMcp(rpc("tools/call", { name, arguments: args }), to, 7);
  expect(answer.status).toBe(200);
  const result = (answer.body as { result: { content: Array<{ text: string }>; isError?: true } }).result;
  return { text: result.content[0]!.text, refused: result.isError === true };
};

describe("the move MCP a Bot in Grok Bot talks to", () => {
  it("shakes hands on a version it knows, answers a ping and takes a notification without a reply", () => {
    const to = link();
    for (const [asked, given] of [["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"], ["2024-11-05", "2024-11-05"], ["1999-01-01", "2025-06-18"], [undefined, "2025-06-18"]]) {
      expect(moveMcp(rpc("initialize", { protocolVersion: asked, capabilities: {} }), to)).toMatchObject({
        status: 200,
        body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: given, capabilities: { tools: {} }, serverInfo: { name: "MausBot" } } },
      });
    }
    expect(moveMcp(rpc("notifications/initialized", undefined, null), to)).toEqual({ status: 202 });
    expect(moveMcp(rpc("ping"), to)).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } });
  });

  it("lists the two tools the published bot calls, with `document` as the one input", () => {
    const tools = (moveMcp(rpc("tools/list"), link()).body as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["move_status", "send_export"]);
    expect(tools[1]!.inputSchema.required).toEqual(["document"]);
  });

  it("keeps a sent Bot as the importer reads it, whether it came as an object or as JSON text, and counts it in the status", () => {
    const to = link();
    expect(call(to, "move_status").text).toBe("Connected to MausBot. 0 Bots received so far. This link works until 2030-01-01T00:00:00.000Z, while MausBot stays open. Send each Bot with send_export, one Bot per call.");
    const sent = call(to, "send_export", { document: {
      ...document("Tango", { memories: ["likes cheese", `the key is ${TOKEN}`], skills: [{ name: "Greet", instructions: "Say hello." }, { name: "Empty" }], extra: { anything: 1 } }),
      stray: "x",
    } });
    expect(sent).toEqual({ refused: false, text: "Arrived in MausBot. Tango: 1 skill, 0 routines, 2 memories. Left out: 1 skill without instructions. Send those again with their full text if the Bot has it. The person can now import it in MausBot, under Settings → Import & export." });
    expect(call(to, "send_export", { document: JSON.stringify(document("Maus")) }).refused).toBe(false);
    expect(call(to, "send_export", { document: document("tango", { memories: ["more"] }) }).refused).toBe(false);

    expect(to.inbox.arrivals.map(({ seq, at, botNames }) => ({ seq, at, botNames }))).toEqual([
      { seq: 1, at: 7, botNames: ["Tango"] }, { seq: 2, at: 7, botNames: ["Maus"] }, { seq: 3, at: 7, botNames: ["tango"] },
    ]);
    const kept = to.inbox.arrivals[0]!.text;
    expect(kept).not.toMatch(/stray|anything|sk-abcdefghij/);
    expect(parseGrokExport(kept)).toMatchObject([{ name: "Tango", memories: ["likes cheese", expect.stringContaining("the key is")] }]);
    expect(call(to, "move_status").text).toContain("2 Bots received so far");
  });

  it("refuses what the importer refuses, with a fix the Bot can act on, and keeps none of it", () => {
    const to = link();
    const refusals: Array<[unknown, string]> = [
      [{ document: document("Tango", { api_key: "real-secret-value" }) }, "passwords or keys in these fields"],
      [{ document: { ...document("Tango"), version: 2 } }, "Send the document with \"version\": 1"],
      [{ document: `{"format":"${GROK_EXPORT_FORMAT}","bots":[{"name":"Tango"` }, "cut off"],
      [{ document: { hello: "there" } }, `that is not a ${GROK_EXPORT_FORMAT} document`],
      [{ document: "x".repeat(GROK_EXPORT_MAX_CHARS + 1) }, "larger than 4 MB"],
      [{ document: 5 }, "as `document`"],
      [{}, "as `document`"],
      [undefined, "as `document`"],
    ];
    for (const [args, says] of refusals) {
      const answer = call(to, "send_export", args);
      expect(answer.refused, says).toBe(true);
      expect(answer.text).toContain("Nothing was saved");
      expect(answer.text).toContain(says);
    }
    expect(to.inbox.arrivals).toEqual([]);
  });

  it("stops taking Bots at a hundred documents, and at sixteen megabytes", () => {
    const full = link();
    for (let count = 0; count < MOVE_MAX_DOCUMENTS; count += 1) expect(call(full, "send_export", { document: document(`Bot ${count}`) }).refused).toBe(false);
    expect(call(full, "send_export", { document: document("One more") })).toMatchObject({ refused: true, text: expect.stringContaining("taken all it can hold") });
    expect(full.inbox.arrivals).toHaveLength(MOVE_MAX_DOCUMENTS);

    const heavy = link();
    const big = "word ".repeat(700_000);
    const fits = Math.floor(MOVE_MAX_BYTES / Buffer.byteLength(JSON.stringify(document("Big", { instructions: big }))));
    for (let count = 0; count < fits; count += 1) expect(call(heavy, "send_export", { document: document("Big", { instructions: big }) }).refused, String(count)).toBe(false);
    expect(call(heavy, "send_export", { document: document("Big", { instructions: big }) }).refused).toBe(true);
    expect(heavy.inbox.arrivals).toHaveLength(fits);
  });

  it("answers anything that is not one known request with a JSON-RPC error", () => {
    const to = link();
    expect(moveMcp(rpc("tools/call", { name: "read_exports" }), to)).toMatchObject({ status: 200, body: { id: 1, error: { code: -32602 } } });
    expect(moveMcp(rpc("resources/list"), to)).toMatchObject({ status: 200, body: { id: 1, error: { code: -32601 } } });
    for (const junk of [null, 5, "hi", [], [rpc("ping")], { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: {}, method: "ping" }]) {
      expect(moveMcp(junk, to), JSON.stringify(junk)).toMatchObject({ status: 400, body: { id: null, error: { code: -32600 } } });
    }
  });
});
