import { describe, expect, it } from "vitest";

import { GROK_EXPORT_FORMAT, GROK_EXPORT_MAX_CHARS, parseGrokExport } from "../shared/grok-import.ts";
import { createMoveLink, HANDOFF_CONTEXT_MAX, HANDOFF_TASK_MAX, HANDOFFS_PER_HOUR, HandoffRefused, MOVE_MAX_BYTES, MOVE_MAX_DOCUMENTS, moveMcp, type HandoffAsk, type HandoffStatus, type MoveHost, type MoveLink } from "./grok-move-mcp.ts";

const TOKEN = "sk-abcdefghijklmnopqrstuvwx";
const link = (host?: MoveHost): MoveLink => {
  let seq = 0;
  return createMoveLink(() => ++seq, host);
};
/** A place with two bots that takes every task and answers each status read with the next of `states`. */
function place(states: HandoffStatus[] = []) {
  const asked: HandoffAsk[] = [];
  const waits: number[] = [];
  const host: MoveHost = {
    bots: () => [{ name: "MausBot", job: "Chief of Staff" }, { name: "Scout" }],
    handOff: async (ask) => {
      if (ask.task === "refuse me") throw new HandoffRefused("MausBot is paused. Tell the person to turn it back on.");
      asked.push(ask);
      return { taskId: `task_${asked.length}`, bot: "MausBot", title: `From Grok Bot: ${ask.task.slice(0, 20)}` };
    },
    status: async (taskId, waitMs) => {
      waits.push(waitMs);
      return taskId.startsWith("task_") ? states.shift() ?? null : null;
    },
  };
  return { host, asked, waits };
}
const document = (name: string, extra: Record<string, unknown> = {}) => ({ format: GROK_EXPORT_FORMAT, version: 1, bots: [{ name, ...extra }] });
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });
const call = async (to: MoveLink, name: string, args: unknown = {}, now = 7) => {
  const answer = await moveMcp(rpc("tools/call", { name, arguments: args }), to, now);
  expect(answer.status).toBe(200);
  const result = (answer.body as { result: { content: Array<{ text: string }>; isError?: true } }).result;
  return { text: result.content[0]!.text, refused: result.isError === true };
};

describe("the move MCP a Bot in Grok Bot talks to", () => {
  it("shakes hands on a version it knows, answers a ping and takes a notification without a reply", async () => {
    const to = link();
    for (const [asked, given] of [["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"], ["2024-11-05", "2024-11-05"], ["1999-01-01", "2025-06-18"], [undefined, "2025-06-18"]]) {
      expect(await moveMcp(rpc("initialize", { protocolVersion: asked, capabilities: {} }), to)).toMatchObject({
        status: 200,
        body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: given, capabilities: { tools: {} }, serverInfo: { name: "MausBot" } } },
      });
    }
    expect(await moveMcp(rpc("notifications/initialized", undefined, null), to)).toEqual({ status: 202 });
    expect(await moveMcp(rpc("ping"), to)).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } });
  });

  it("lists the two tools the published bot calls, unchanged, and the two for handing a task off", async () => {
    const tools = ((await moveMcp(rpc("tools/list"), link())).body as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["move_status", "send_export", "hand_off_task", "task_status"]);
    expect(tools.map((tool) => tool.inputSchema.required)).toEqual([undefined, ["document"], ["task"], ["task_id"]]);
  });

  it("keeps a sent Bot as the importer reads it, whether it came as an object or as JSON text, and counts it in the status", async () => {
    const to = link();
    expect((await call(to, "move_status")).text).toBe("Connected to MausBot. 0 Bots received so far. This link works while MausBot stays open, until the person turns it off. To move a Bot, send it with send_export, one Bot per call. To have MausBot do something, call hand_off_task.");
    expect((await call(link(place().host), "move_status")).text).toContain("MausBot's bots: MausBot (Chief of Staff); Scout.");
    const crowd: MoveHost = { ...place().host, bots: () => Array.from({ length: 34 }, (_, index) => ({ name: `Bot ${index}` })) };
    expect((await call(link(crowd), "move_status")).text).toMatch(/Bot 29; and 4 more\.$/);
    const sent = await call(to, "send_export", { document: {
      ...document("Tango", { memories: ["likes cheese", `the key is ${TOKEN}`], skills: [{ name: "Greet", instructions: "Say hello." }, { name: "Empty" }], extra: { anything: 1 } }),
      stray: "x",
    } });
    expect(sent).toEqual({ refused: false, text: "Arrived in MausBot. Tango: 1 skill, 0 routines, 2 memories. Left out: 1 skill without instructions. Send those again with their full text if the Bot has it. The person can now import it in MausBot, under Settings → Import." });
    expect((await call(to, "send_export", { document: JSON.stringify(document("Maus")) })).refused).toBe(false);
    expect((await call(to, "send_export", { document: document("tango", { memories: ["more"] }) })).refused).toBe(false);

    expect(to.inbox.arrivals.map(({ seq, at, botNames }) => ({ seq, at, botNames }))).toEqual([
      { seq: 1, at: 7, botNames: ["Tango"] }, { seq: 2, at: 7, botNames: ["Maus"] }, { seq: 3, at: 7, botNames: ["tango"] },
    ]);
    const kept = to.inbox.arrivals[0]!.text;
    expect(kept).not.toMatch(/stray|anything|sk-abcdefghij/);
    expect(parseGrokExport(kept)).toMatchObject([{ name: "Tango", memories: ["likes cheese", expect.stringContaining("the key is")] }]);
    expect((await call(to, "move_status")).text).toContain("2 Bots received so far");
  });

  it("refuses what the importer refuses, with a fix the Bot can act on, and keeps none of it", async () => {
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
      const answer = await call(to, "send_export", args);
      expect(answer.refused, says).toBe(true);
      expect(answer.text).toContain("Nothing was saved");
      expect(answer.text).toContain(says);
    }
    expect(to.inbox.arrivals).toEqual([]);
  });

  it("stops taking Bots at a hundred documents, and at sixteen megabytes", async () => {
    const full = link();
    for (let count = 0; count < MOVE_MAX_DOCUMENTS; count += 1) expect((await call(full, "send_export", { document: document(`Bot ${count}`) })).refused).toBe(false);
    expect(await call(full, "send_export", { document: document("One more") })).toMatchObject({ refused: true, text: expect.stringContaining("taken all it can hold") });
    // What the person imported is let go, and its room is free again.
    full.inbox.take(full.inbox.arrivals[1]!.seq);
    expect(full.inbox.arrivals).toHaveLength(MOVE_MAX_DOCUMENTS - 2);
    expect((await call(full, "send_export", { document: document("One more") })).refused).toBe(false);
    full.inbox.take(0);
    expect(full.inbox.arrivals).toHaveLength(MOVE_MAX_DOCUMENTS - 1);

    const heavy = link();
    const big = "word ".repeat(700_000);
    const fits = Math.floor(MOVE_MAX_BYTES / Buffer.byteLength(JSON.stringify(document("Big", { instructions: big }))));
    for (let count = 0; count < fits; count += 1) expect((await call(heavy, "send_export", { document: document("Big", { instructions: big }) })).refused, String(count)).toBe(false);
    expect((await call(heavy, "send_export", { document: document("Big", { instructions: big }) })).refused).toBe(true);
    expect(heavy.inbox.arrivals).toHaveLength(fits);
  });

  it("hands a task to the place and gives back an id, the bot and the title to relay", async () => {
    const { host, asked } = place();
    const to = link(host);
    const made = await call(to, "hand_off_task", { task: "  Draft the launch post  ", to_bot: " Scout\n", context: "It ships Friday." });
    expect(made).toEqual({ refused: false, text: 'Handed to MausBot in MausBot as "From Grok Bot: Draft the launch pos". task_id: task_1. Read the result with task_status and this task_id. MausBot asks the person directly, in MausBot, if it needs an approval or an answer.' });
    expect(asked).toEqual([{ task: "Draft the launch post", toBot: "Scout", context: "It ships Friday." }]);
    await call(to, "hand_off_task", { task: "Just this" });
    expect(asked[1]).toEqual({ task: "Just this" });
  });

  it("refuses a task that is missing or too long, and a place that cannot take it, each with the fix, and hands nothing off", async () => {
    const { host, asked } = place();
    const to = link(host);
    const refusals: Array<[unknown, string]> = [
      [{}, "say what to do as `task`"],
      [{ task: "   " }, "say what to do as `task`"],
      [{ task: 5 }, "say what to do as `task`"],
      [undefined, "say what to do as `task`"],
      [{ task: "x".repeat(HANDOFF_TASK_MAX + 1) }, "`task` is longer than 8,000 characters"],
      [{ task: "ok", context: "x".repeat(HANDOFF_CONTEXT_MAX + 1) }, "`context` is longer than 16,000 characters"],
      [{ task: "refuse me" }, "MausBot is paused. Tell the person to turn it back on."],
    ];
    for (const [args, says] of refusals) {
      const answer = await call(to, "hand_off_task", args);
      expect(answer.refused, says).toBe(true);
      expect(answer.text).toContain("Nothing was handed off");
      expect(answer.text).toContain(says);
    }
    expect(asked).toEqual([]);
    expect((await call(to, "hand_off_task", { task: "x".repeat(HANDOFF_TASK_MAX), context: "x".repeat(HANDOFF_CONTEXT_MAX) })).refused).toBe(false);
    expect((await call(link(), "hand_off_task", { task: "No place behind this link" })).text).toContain("cannot take tasks right now");
  });

  it("hands off at most thirty tasks an hour per link, counting neither refusals nor another link's", async () => {
    const { host, asked } = place();
    const to = link(host);
    const hour = 60 * 60 * 1000;
    await call(to, "hand_off_task", { task: "refuse me" }, 0);
    const all = await Promise.all(Array.from({ length: HANDOFFS_PER_HOUR + 1 }, (_, index) => call(to, "hand_off_task", { task: `Task ${index}` }, index)));
    expect(all.filter((answer) => answer.refused)).toEqual([{ refused: true, text: "Nothing was handed off: this link has handed off 30 tasks in the last hour. Try again after 1970-01-01T01:00:00.000Z." }]);
    expect(asked).toHaveLength(HANDOFFS_PER_HOUR);
    expect((await call(link(host), "hand_off_task", { task: "Another link" }, 5)).refused).toBe(false);
    expect((await call(to, "hand_off_task", { task: "Still full" }, hour - 1)).refused).toBe(true);
    expect((await call(to, "hand_off_task", { task: "An hour on" }, hour)).refused).toBe(false);
  });

  it("reads a task it handed off: working, waiting for the person, done with the result, failed or stopped", async () => {
    const on = ["MausBot", "Scout"];
    const { host, waits } = place([
      { title: "From Grok Bot: Draft", state: "working", on },
      { title: "From Grok Bot: Draft", state: "needs_you", on, detail: "May I post it to the blog?" },
      { title: "From Grok Bot: Draft", state: "done", on, result: `Posted. ${"x".repeat(5_000)}` },
      { title: "From Grok Bot: Draft", state: "done", on: ["MausBot"] },
      { title: "From Grok Bot: Draft", state: "failed", on, detail: "MausBot's engine stopped unexpectedly" },
      { title: "From Grok Bot: Draft", state: "stopped", on, result: "Half a draft." },
    ]);
    const to = link(host);
    await call(to, "hand_off_task", { task: "Draft" });
    const read = async (args: Record<string, unknown> = {}) => (await call(to, "task_status", { task_id: "task_1", ...args }));
    expect(await read()).toEqual({ refused: false, text: '"From Grok Bot: Draft" is being worked on. On it: MausBot, Scout. Call task_status again; wait_seconds up to 25 holds the answer until something changes.' });
    expect((await read({ wait_seconds: 10 })).text).toBe('"From Grok Bot: Draft" is waiting for the person. MausBot asks: May I post it to the blog? Only the person can answer, and they answer in MausBot: tell them to open MausBot. Then call task_status again. On it: MausBot, Scout.');
    const done = (await read({ wait_seconds: 900 })).text;
    expect(done).toMatch(/^"From Grok Bot: Draft" is done\. On it: MausBot, Scout\.\n\nResult:\nPosted\. x+$/);
    expect(done.split("Result:\n")[1]).toHaveLength(4_000);
    expect((await read({ wait_seconds: -3 })).text).toContain("MausBot gave no reply text");
    expect((await read({ wait_seconds: "soon" })).text).toBe("\"From Grok Bot: Draft\" failed: MausBot's engine stopped unexpectedly On it: MausBot, Scout. The person can open it in MausBot, or you can hand it off again.");
    expect((await read()).text).toBe('"From Grok Bot: Draft" was stopped in MausBot. On it: MausBot, Scout.\n\nResult:\nHalf a draft.');
    expect(waits).toEqual([0, 10_000, 25_000, 0, 0, 0]);
  });

  it("says not found for a task id it never gave out: another link's, a made-up one, or none", async () => {
    const { host, waits } = place([{ title: "t", state: "done", on: [] }]);
    const mine = link(host);
    const other = link(host);
    await call(other, "hand_off_task", { task: "Theirs" });
    for (const args of [{ task_id: "task_1" }, { task_id: "task_999" }, { task_id: 5 }, {}, undefined]) {
      expect(await call(mine, "task_status", args), JSON.stringify(args)).toEqual({ refused: true, text: "No task with that task_id was handed off through this link. Use the task_id hand_off_task returned." });
    }
    expect(waits).toEqual([]);
    expect((await call(other, "task_status", { task_id: "task_1" })).refused).toBe(false);
  });

  it("answers anything that is not one known request with a JSON-RPC error", async () => {
    const to = link();
    expect(await moveMcp(rpc("tools/call", { name: "read_exports" }), to)).toMatchObject({ status: 200, body: { id: 1, error: { code: -32602 } } });
    expect(await moveMcp(rpc("resources/list"), to)).toMatchObject({ status: 200, body: { id: 1, error: { code: -32601 } } });
    for (const junk of [null, 5, "hi", [], [rpc("ping")], { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: {}, method: "ping" }]) {
      expect(await moveMcp(junk, to), JSON.stringify(junk)).toMatchObject({ status: 400, body: { id: null, error: { code: -32600 } } });
    }
  });
});
