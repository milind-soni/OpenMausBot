import { describe, expect, it } from "vitest";

import { GROK_EXPORT_FORMAT, GROK_EXPORT_MAX_CHARS, parseGrokExport } from "../shared/grok-import.ts";
import { GROK_LINK_BODY_MAX } from "../shared/grok-link.ts";
import { createMoveLink, grokPageSlug, HANDOFF_CONTEXT_MAX, HANDOFF_TASK_MAX, HANDOFFS_PER_HOUR, HandoffRefused, MOVE_FILE_MAX_BYTES, MOVE_MAX_ASSET_BYTES, MOVE_MAX_ASSETS, MOVE_MAX_BYTES, MOVE_MAX_DOCUMENTS, MOVE_PAGE_MAX_BYTES, moveAssetsFor, moveBusy, moveManifest, moveMcp, type HandoffAsk, type HandoffStatus, type MoveHost, type MoveLink } from "./grok-move-mcp.ts";

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
const PAGE = `import { Chart } from "mausbot";
const visits = [12, 18, 9];
export default function Page() {
  return <main className="p-6"><h1 className="text-xl font-semibold">Sales</h1><Chart option={{ series: [{ type: "bar", data: visits }] }} /></main>;
}`;
const GROK_SOURCE = `import { Page, Section, Metrics } from "grok/canvas";
const visits = [12, 18, 9];
export default function Canvas() { return <Page><Section title="Sales"><Metrics data={visits} /></Section></Page>; }`;
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
        body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: given, capabilities: { tools: {} }, serverInfo: { name: "MausBot" },
          instructions: expect.stringContaining("when a tool says MausBot isn't open, ask the person to open it, then call the tool again.") } },
      });
    }
    expect(await moveMcp(rpc("notifications/initialized", undefined, null), to)).toEqual({ status: 202 });
    expect(await moveMcp(rpc("ping"), to)).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } });
  });

  it("lists the two tools the published bot calls, unchanged, the two for pages and files, and the two for handing a task off", async () => {
    const tools = ((await moveMcp(rpc("tools/list"), link())).body as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["move_status", "send_export", "send_page", "send_file", "hand_off_task", "task_status"]);
    expect(tools.map((tool) => tool.inputSchema.required)).toEqual([undefined, ["document"], ["bot", "title", "page"], ["bot", "path"], ["task"], ["task_id"]]);
  });

  it("asks for each Bot's handover note, keeps it, and says when one came and when one did not", async () => {
    const tools = ((await moveMcp(rpc("tools/list"), link())).body as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
    expect(tools.find((tool) => tool.name === "send_export")!.description).toMatch(/\{name, title, instructions, memories, user_facts, handover, skills, routines, apps\}.*`handover` is the Bot's handover note.*for each project or ongoing piece of work, what it is, where it stands, the next steps, open questions, decisions made, and the files it uses.*under 100 lines/);
    const to = link();
    expect((await call(to, "send_export", { document: document("Tango", { instructions: "Dance.", handover: `Renewals: waiting on legal. Key ${TOKEN}` }) })).text)
      .toBe("Arrived in MausBot. Tango: 0 skills, 0 routines, 0 memories, its handover note. The person can now import it in MausBot, under Settings → Import & export.");
    expect(parseGrokExport(to.inbox.arrivals[0]!.text)[0]!.handover).toMatch(/^Renewals: waiting on legal\. Key (?!sk-abcdefghij)/);
    expect((await call(to, "send_export", { document: document("Maus", { instructions: "Squeak." }) })).text).toContain("Maus: 0 skills, 0 routines, 0 memories. Left out: its handover note.");
  });

  it("hands the hosted address the handshake and the tool list it gives itself, and words for when it isn't there", async () => {
    const manifest = moveManifest();
    const listed = (await moveMcp(rpc("tools/list"), link())).body as { result: unknown };
    const greeted = (await moveMcp(rpc("initialize", {}), link())).body as { result: unknown };
    expect(manifest.tools).toEqual(listed.result);
    expect({ ...manifest.initialize, protocolVersion: manifest.versions[0] }).toEqual(greeted.result);
    expect(manifest.versions).toEqual(["2025-06-18", "2025-03-26", "2024-11-05"]);
    expect(manifest.offline).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining("MausBot isn't open on the person's computer") }] });
    expect(manifest.late).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining("MausBot didn't answer in time") }] });
    expect(JSON.stringify(manifest)).not.toMatch(/address changes|new link/);
    expect(moveBusy(4)).toMatchObject({ status: 200, body: { id: 4, result: { isError: true } } });
  });

  it("keeps a sent Bot as the importer reads it, whether it came as an object or as JSON text, and counts it in the status", async () => {
    const to = link();
    expect((await call(to, "move_status")).text).toBe("Connected to MausBot. 0 Bots, 0 pages and 0 files received so far and waiting for the person to import. This link stays on until the person turns it off, and its address never changes. To move a Bot, send it in this order: its setup with send_export, one Bot per call, with its handover note; then each of its pages with send_page; then each of its files with send_file. To have MausBot do something, call hand_off_task.");
    expect((await call(link(place().host), "move_status")).text).toContain("MausBot's bots: MausBot (Chief of Staff); Scout.");
    const crowd: MoveHost = { ...place().host, bots: () => Array.from({ length: 34 }, (_, index) => ({ name: `Bot ${index}` })) };
    expect((await call(link(crowd), "move_status")).text).toMatch(/Bot 29; and 4 more\.$/);
    const sent = await call(to, "send_export", { document: {
      ...document("Tango", { memories: ["likes cheese", `the key is ${TOKEN}`], skills: [{ name: "Greet", instructions: "Say hello." }, { name: "Empty" }], extra: { anything: 1 } }),
      stray: "x",
    } });
    expect(sent).toEqual({ refused: false, text: "Arrived in MausBot. Tango: 1 skill, 0 routines, 2 memories. Left out: 1 skill without instructions and its handover note. Send those again with their full text if the Bot has it. The person can now import it in MausBot, under Settings → Import & export." });
    expect((await call(to, "send_export", { document: JSON.stringify(document("Maus")) })).refused).toBe(false);
    expect((await call(to, "send_export", { document: document("tango", { memories: ["more"] }) })).refused).toBe(false);

    expect(to.inbox.arrivals.map(({ seq, at, botNames }) => ({ seq, at, botNames }))).toEqual([
      { seq: 1, at: 7, botNames: ["Tango"] }, { seq: 2, at: 7, botNames: ["Maus"] }, { seq: 3, at: 7, botNames: ["tango"] },
    ]);
    const kept = to.inbox.arrivals[0]!.text;
    expect(kept).not.toMatch(/stray|anything|sk-abcdefghij/);
    expect(parseGrokExport(kept)).toMatchObject([{ name: "Tango", memories: ["likes cheese", expect.stringContaining("the key is")] }]);
    expect((await call(to, "move_status")).text).toContain("2 Bots, 0 pages and 0 files received so far");
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

  it("takes a Bot's page as a page file that compiles, beside its original, and counts it in the status", async () => {
    const to = link();
    const sent = await call(to, "send_page", { bot: "  New Bot   1731b8e0 ", title: " Sales\ndashboard ", page: PAGE, source: GROK_SOURCE });
    expect(sent).toEqual({ refused: false, text: "Arrived in MausBot: the page \"Sales dashboard\" for New Bot 1731b8e0. The person imports it in MausBot, under Settings → Import & export, and it opens in New Bot 1731b8e0's Library." });
    expect((await call(to, "send_page", { bot: "Tango", title: "Notes", page: PAGE })).refused).toBe(false);
    expect(to.inbox.assets).toEqual([
      { seq: 1, at: 7, kind: "page", bot: "New Bot 1731b8e0", title: "Sales dashboard", page: PAGE, source: GROK_SOURCE },
      { seq: 2, at: 7, kind: "page", bot: "Tango", title: "Notes", page: PAGE },
    ]);
    expect(moveAssetsFor(to.inbox, "new bot 1731B8E0").map((asset) => asset.seq)).toEqual([1]);
    expect((await call(to, "move_status")).text).toContain("0 Bots, 2 pages and 0 files received so far");

    const again = await call(to, "send_page", { bot: "tango", title: "NOTES!", page: `${PAGE}\n` });
    expect(again.refused).toBe(false);
    expect(to.inbox.assets.map(({ seq, bot }) => ({ seq, bot }))).toEqual([{ seq: 1, bot: "New Bot 1731b8e0" }, { seq: 3, bot: "tango" }]);
    expect(grokPageSlug("  Q3: Sales & Visits — 2026 ")).toBe("q3-sales-visits-2026");
    expect(grokPageSlug("बिक्री रिपोर्ट")).toBe("बिक्री-रिपोर्ट");
    expect(grokPageSlug("!!!")).toBe("page");
  });

  it("refuses a page it could not show, with the fix, and keeps none of it", async () => {
    const to = link();
    const good = { bot: "Tango", title: "Sales", page: PAGE };
    const refusals: Array<[unknown, string]> = [
      [{ ...good, bot: " " }, "say which Bot it belongs to as `bot`"],
      [{ ...good, title: "" }, "give the page's title as `title`"],
      [{ ...good, page: 5 }, "send the page as `page`"],
      [{ ...good, page: "const a = 1;" }, "`page` needs `export default`"],
      [{ ...good, page: GROK_SOURCE }, "`page`: imports grok/canvas; a page can import only react,"],
      [{ ...good, page: "export default function Page() { return <div>; }" }, "`page`: line 1:"],
      [{ ...good, page: `${PAGE}\n// ${"x".repeat(MOVE_PAGE_MAX_BYTES)}` }, "`page` is larger than 1 MB"],
      [{ ...good, source: "x".repeat(MOVE_PAGE_MAX_BYTES + 1) }, "Send the page again without `source`"],
      [{ ...good, source: { tsx: true } }, "`source` is the original file's text"],
      [{ ...good, page: `${PAGE}\nconst key = "${TOKEN}";` }, "has a key or password in it"],
      [{ ...good, source: `const key = "${TOKEN}";` }, "has a key or password in it"],
      [undefined, "say which Bot it belongs to"],
    ];
    for (const [args, says] of refusals) {
      const answer = await call(to, "send_page", args);
      expect(answer.refused, says).toBe(true);
      expect(answer.text).toContain("Nothing was saved");
      expect(answer.text).toContain(says);
    }
    expect(to.inbox.assets).toEqual([]);
  });

  it("takes a Bot's file as text or as base64, one of the two, and counts it in the status", async () => {
    const to = link();
    const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1]);
    expect(await call(to, "send_file", { bot: "Tango", path: "./reports/2026/summary.md", text: "# Summary" })).toEqual({ refused: false, text: "Arrived in MausBot: reports/2026/summary.md for Tango." });
    expect((await call(to, "send_file", { bot: "Tango", path: "logo.png", base64: `${picture.toString("base64").slice(0, 4)}\n${picture.toString("base64").slice(4)}` })).refused).toBe(false);
    expect((await call(to, "send_file", { bot: "Tango", path: "empty.txt", text: "" })).refused).toBe(false);
    expect(to.inbox.assets).toEqual([
      { seq: 1, at: 7, kind: "file", bot: "Tango", path: "reports/2026/summary.md", data: Buffer.from("# Summary") },
      { seq: 2, at: 7, kind: "file", bot: "Tango", path: "logo.png", data: picture },
      { seq: 3, at: 7, kind: "file", bot: "Tango", path: "empty.txt", data: Buffer.alloc(0) },
    ]);
    expect((await call(to, "send_file", { bot: "Tango", path: "logo.png", text: "now text" })).refused).toBe(false);
    expect(to.inbox.assets.map((asset) => asset.seq)).toEqual([1, 3, 4]);
    expect((await call(to, "move_status")).text).toContain("0 Bots, 0 pages and 3 files received so far");
    const whole = Buffer.alloc(MOVE_FILE_MAX_BYTES, 7);
    expect(JSON.stringify(rpc("tools/call", { name: "send_file", arguments: { bot: "x".repeat(200), path: "x".repeat(300), base64: whole.toString("base64") } })).length).toBeLessThan(GROK_LINK_BODY_MAX);
    expect((await call(to, "send_file", { bot: "Tango", path: "whole.bin", base64: whole.toString("base64") })).refused).toBe(false);
  });

  it("refuses a file with a path a folder can't hold, a credential's name or shape, both or neither content, or over 3 MB, and keeps none of it", async () => {
    const to = link();
    const refusals: Array<[unknown, string]> = [
      [{ path: "a.txt", text: "x" }, "say which Bot it belongs to as `bot`"],
      [{ bot: "Tango", text: "x" }, "give the file's path as `path`"],
      [{ bot: "Tango", path: "../outside.txt", text: "x" }, "../outside.txt is not a path a folder can hold"],
      [{ bot: "Tango", path: "/workspace/a.txt", text: "x" }, "is not a path a folder can hold"],
      [{ bot: "Tango", path: "a\\b.txt", text: "x" }, "is not a path a folder can hold"],
      [{ bot: "Tango", path: ".config/settings.json", text: "x" }, "is hidden or in a hidden folder"],
      [{ bot: "Tango", path: "app/node_modules/x/index.js", text: "x" }, "is in a package or cache folder"],
      [{ bot: "Tango", path: "a/b/c/d/e/f/g.txt", text: "x" }, "more than six folders deep"],
      [{ bot: "Tango", path: ".env", text: "A=1" }, "is hidden"],
      [{ bot: "Tango", path: "prod.env", text: "A=1" }, "is named like a key or password file"],
      [{ bot: "Tango", path: "keys/server.pem", text: "x" }, "is named like a key or password file"],
      [{ bot: "Tango", path: "ssh/id_rsa", text: "x" }, "is named like a key or password file"],
      [{ bot: "Tango", path: "credentials.json", text: "{}" }, "is named like a key or password file"],
      [{ bot: "Tango", path: "a.txt" }, "send exactly one of `text`"],
      [{ bot: "Tango", path: "a.txt", text: "x", base64: "eA==" }, "send exactly one of `text`"],
      [{ bot: "Tango", path: "a.txt", base64: 5 }, "send exactly one of `text`"],
      [{ bot: "Tango", path: "a.bin", base64: "not base64!" }, "`base64` is not base64"],
      [{ bot: "Tango", path: "big.txt", text: "x".repeat(MOVE_FILE_MAX_BYTES + 1) }, "big.txt is larger than 3 MB"],
      [{ bot: "Tango", path: "big.bin", base64: Buffer.alloc(MOVE_FILE_MAX_BYTES + 1).toString("base64") }, "big.bin is larger than 3 MB"],
      [{ bot: "Tango", path: "notes.txt", text: `key ${TOKEN}` }, "notes.txt has a key or password in it"],
      [{ bot: "Tango", path: "notes.bin", base64: Buffer.from(`key ${TOKEN}`).toString("base64") }, "notes.bin has a key or password in it"],
    ];
    for (const [args, says] of refusals) {
      const answer = await call(to, "send_file", args);
      expect(answer.refused, says).toBe(true);
      expect(answer.text).toContain("Nothing was saved");
      expect(answer.text).toContain(says);
    }
    expect(to.inbox.assets).toEqual([]);
  });

  it("stops taking pages and files at a thousand, and at sixty-four megabytes, apart from the room for Bots", async () => {
    const full = link();
    for (let count = 0; count < MOVE_MAX_ASSETS; count += 1) expect(full.inbox.addAsset({ kind: "file", at: 1, bot: "Tango", path: `f${count}.txt`, data: Buffer.from("x") })).toBe(true);
    expect(await call(full, "send_file", { bot: "Tango", path: "one-more.txt", text: "x" })).toEqual({ refused: true, text: expect.stringContaining("taken all the pages and files it can hold. Tell the person to import what has arrived in MausBot, then send the rest.") });
    expect(await call(full, "send_page", { bot: "Tango", title: "One more", page: PAGE })).toMatchObject({ refused: true, text: expect.stringContaining("taken all the pages and files it can hold") });
    expect((await call(full, "send_file", { bot: "Tango", path: "f3.txt", text: "sent again" })).refused).toBe(false);
    expect((await call(full, "send_export", { document: document("Tango") })).refused).toBe(false);
    full.inbox.drop([full.inbox.assets[0]!.seq]);
    full.inbox.take(Number.MAX_SAFE_INTEGER);
    expect(full.inbox.assets).toHaveLength(MOVE_MAX_ASSETS - 1);
    expect((await call(full, "send_page", { bot: "Tango", title: "One more", page: PAGE })).refused).toBe(false);

    const heavy = link();
    const block = Buffer.alloc(MOVE_FILE_MAX_BYTES);
    const fits = Math.floor(MOVE_MAX_ASSET_BYTES / MOVE_FILE_MAX_BYTES);
    for (let count = 0; count < fits; count += 1) expect(heavy.inbox.addAsset({ kind: "file", at: 1, bot: "Tango", path: `f${count}.bin`, data: block })).toBe(true);
    expect((await call(heavy, "send_file", { bot: "Tango", path: "over.bin", base64: block.toString("base64") })).refused).toBe(true);
    expect((await call(heavy, "send_file", { bot: "Tango", path: "f0.bin", base64: block.toString("base64") })).refused).toBe(false);
    expect(heavy.inbox.assets).toHaveLength(fits);
  });

  it("gives a caller no way to read back what it or anyone sent", async () => {
    const to = link();
    const secret = "only-the-person-sees-this";
    const page = PAGE.replace("Sales", secret);
    const answers = [
      await call(to, "send_export", { document: document("Tango", { instructions: secret }) }),
      await call(to, "send_page", { bot: "Tango", title: "Sales", page, source: secret }),
      await call(to, "send_file", { bot: "Tango", path: "a.txt", text: secret }),
      await call(to, "send_page", { bot: "Tango", title: "Sales", page: `${page}\nimport "fs";` }),
      await call(to, "send_file", { bot: "Tango", path: "../a.txt", text: secret }),
      await call(to, "move_status"),
    ];
    expect(to.inbox.assets).toHaveLength(2);
    expect(JSON.stringify(answers)).not.toContain(secret);
    for (const name of ["read_page", "get_file", "list_files", "read_exports"]) {
      expect(await moveMcp(rpc("tools/call", { name, arguments: { bot: "Tango", path: "a.txt", title: "Sales" } }), to)).toMatchObject({ body: { error: { code: -32602 } } });
    }
    const listed = JSON.stringify((await moveMcp(rpc("tools/list"), to)).body);
    expect(listed).not.toMatch(/"(?:read|get|list|download)_/);
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
