import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStayedNotices, stayedConnectors, stayedLine } from "./cloud-connections-stayed.ts";
import { isMailConnector, runsHere } from "./cloud-connections.ts";

const MAC = { environmentId: "env-1", label: "Mac mini" };
const stdio = (command: string, args: string[], extra: Record<string, unknown> = {}) => ({ command, args, env: {}, enabled: true, ...extra });
const SERVERS = {
  easy: stdio("uvx", ["mcp-email-server", "stdio"], { runsOn: MAC }),
  fetch: stdio("uvx", ["mcp-server-fetch"], { runsOn: MAC }),
  notes: stdio("node", ["/Users/someone/notes.js"], { runsOn: MAC }),
  off: stdio("uvx", ["mcp-server-time"], { runsOn: MAC, enabled: false }),
  dodo: stdio("npx", ["-y", "dodopayments-mcp"]),
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(bots: Array<{ id: string; name: string; threadId: string; chiefOfStaff?: boolean; mcpServers?: string[]; toolScope?: unknown }>, servers: Record<string, unknown> = SERVERS, file?: string, mailConnected?: () => boolean, lent?: (runsOn: { environmentId: string; label: string }) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "omb-stayed-")); dirs.push(dir);
  const said: Array<{ threadId: string; text: string; kind: string }> = [];
  const notified: Array<{ text: string; bot: string; threadId: string }> = [];
  const notices = createStayedNotices({
    file: file ?? join(dir, "told.json"), origin: "https://omb-u-1.fly.dev", servers: () => servers, programs: () => ["npx", "node", "python3"], bots: () => bots, language: () => undefined,
    ...(mailConnected ? { mailConnected } : {}),
    ...(lent ? { lent } : {}),
    say: (threadId, text, kind) => { said.push({ threadId, text, kind }); },
    notify: (text, bot, threadId) => { notified.push({ text, bot: bot.id, threadId }); },
  });
  return { notices, said, notified, file: file ?? join(dir, "told.json") };
}

describe("what stayed on the person's computer", () => {
  it("says nothing stayed when the computer a connector runs on is lent here, since bots reach it through that computer", () => {
    const bots = [{ id: "a", name: "Ada", threadId: "t-a", chiefOfStaff: true }];
    const lentHere = fixture(bots, SERVERS, undefined, undefined, (runsOn) => runsOn.environmentId === MAC.environmentId);
    lentHere.notices.moved();
    lentHere.notices.personTurn(bots[0]!, "t-a");
    expect(lentHere.said).toEqual([]);
    expect(lentHere.notified).toEqual([]);
    const notLent = fixture(bots, SERVERS, undefined, undefined, () => false);
    notLent.notices.moved();
    expect(notLent.said).toHaveLength(1);
  });

  it("names each connector that runs elsewhere with why, and leaves out one that was off anyway", () => {
    expect(stayedConnectors(SERVERS, ["npx", "node", "python3"])).toEqual([
      { name: "easy", computer: "Mac mini", runsOn: MAC, why: { kind: "mail" } },
      { name: "fetch", computer: "Mac mini", runsOn: MAC, why: { kind: "program", program: "uvx" } },
      { name: "notes", computer: "Mac mini", runsOn: MAC, why: { kind: "here" } },
    ]);
  });

  it("says it in plain words: the program it needs, or that its mail stays there", () => {
    const [easy, fetch, notes] = stayedConnectors(SERVERS, ["npx", "node", "python3"]);
    expect(stayedLine(undefined, easy!)).toBe("easy stayed on Mac mini when your bots moved to My Cloud, so bots here can't read or send mail through it. It keeps its accounts on Mac mini, and it can't reach a mail server from here. To read and send mail from My Cloud, connect your mailbox under Connected apps.");
    expect(stayedLine(undefined, fetch!)).toBe("fetch stayed on Mac mini when your bots moved to My Cloud, so bots here can't use it. It needs uvx, which My Cloud doesn't have.");
    expect(stayedLine(undefined, notes!)).toBe("notes stayed on Mac mini when your bots moved to My Cloud, so bots here can't use it. It uses files or an address only Mac mini has.");
  });

  it("when the move ends one bot says all of it, once, and the person is told outside the chat too", () => {
    const { notices, said, notified } = fixture([{ id: "a", name: "Ada", threadId: "t-a" }, { id: "c", name: "Chief", threadId: "t-c", chiefOfStaff: true }]);
    notices.moved();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ threadId: "t-c", kind: "line" });
    expect(said[0]!.text.split("\n\n").map((line) => line.split(" ")[0])).toEqual(["easy", "fetch", "notes", "https://omb-u-1.fly.dev/?connect=email"]);
    expect(notified).toEqual([{ text: said[0]!.text, bot: "c", threadId: "t-c" }]);
    notices.moved();
    expect(said, "a move resumed after a crash says nothing twice").toHaveLength(1);
  });

  it("the first conversation with each other bot that could have used it says so once, in that conversation", () => {
    const { notices, said } = fixture([{ id: "a", name: "Ada", threadId: "t-a" }, { id: "c", name: "Chief", threadId: "t-c", chiefOfStaff: true }, { id: "n", name: "Nora", threadId: "t-n", mcpServers: ["dodo"] }]);
    notices.moved();
    said.length = 0;
    notices.personTurn({ id: "c", name: "Chief", threadId: "t-c", chiefOfStaff: true }, "t-c-2");
    expect(said, "the bot that said it at the move does not repeat it").toEqual([]);
    notices.personTurn({ id: "a", name: "Ada", threadId: "t-a" }, "t-a-7");
    expect(said.map(({ threadId, kind, text }) => [threadId, kind, text.split(" ")[0]])).toEqual([["t-a-7", "row", "easy"], ["t-a-7", "row", "fetch"], ["t-a-7", "row", "notes"]]);
    said.length = 0;
    notices.personTurn({ id: "a", name: "Ada", threadId: "t-a" }, "t-a-8");
    expect(said, "once per bot").toEqual([]);
    notices.personTurn({ id: "n", name: "Nora", threadId: "t-n", mcpServers: ["dodo"] }, "t-n-1");
    expect(said, "a bot that never had it hears nothing").toEqual([]);
  });

  it("someone who moved before this existed is told too, on their first line", () => {
    const { notices, said } = fixture([{ id: "a", name: "Ada", threadId: "t-a" }]);
    notices.personTurn({ id: "a", name: "Ada", threadId: "t-a" }, "t-a");
    expect(said.map((line) => line.text.split(" ")[0])).toEqual(["easy", "fetch", "notes"]);
  });

  it("what was said is kept across a restart", () => {
    const first = fixture([{ id: "a", name: "Ada", threadId: "t-a" }]);
    first.notices.personTurn({ id: "a", name: "Ada", threadId: "t-a" }, "t-a");
    const again = fixture([{ id: "a", name: "Ada", threadId: "t-a" }], SERVERS, first.file);
    again.notices.personTurn({ id: "a", name: "Ada", threadId: "t-a" }, "t-a");
    expect(again.said).toEqual([]);
  });

  it("a bot's own connector is said only to that bot, and a tool selection without it says nothing", () => {
    const servers = { own: stdio("uvx", ["mcp-server-own"], { runsOn: MAC, bot: "a" }) };
    const { notices, said } = fixture([{ id: "b", name: "Bea", threadId: "t-b" }, { id: "a", name: "Ada", threadId: "t-a", toolScope: { mode: "selected", mcp: {} } }], servers);
    notices.personTurn({ id: "b", name: "Bea", threadId: "t-b" }, "t-b");
    expect(said).toEqual([]);
  });

  it("a mail connector left behind isn't mentioned once a mailbox is connected here", () => {
    const { notices, said } = fixture([{ id: "a", name: "Ada", threadId: "t-a" }], { easy: SERVERS.easy, fetch: SERVERS.fetch }, undefined, () => true);
    notices.personTurn({ id: "a", name: "Ada", threadId: "t-a" }, "t-a");
    expect(said.map((line) => line.text.split(" ")[0])).toEqual(["fetch"]);
  });

  it("nothing is said where nothing stayed", () => {
    const { notices, said, notified } = fixture([{ id: "a", name: "Ada", threadId: "t-a" }], { dodo: SERVERS.dodo });
    notices.moved();
    notices.personTurn({ id: "a", name: "Ada", threadId: "t-a" }, "t-a");
    expect(said).toEqual([]);
    expect(notified).toEqual([]);
  });
});

describe("a mail connector stays where its accounts are", () => {
  it.each([
    [stdio("uvx", ["mcp-email-server", "stdio"]), true],
    [stdio("npx", ["-y", "imap-mcp"]), true],
    [stdio("uvx", ["mcp-server-smtp"]), true],
    [stdio("npx", ["himalaya-mcp"]), true],
    [stdio("npx", ["-y", "@scope/mail-tools"]), false],
    [stdio("npx", ["-y", "gmail-mcp"]), false],
    [stdio("uvx", ["mcp-server-fetch"]), false],
  ])("%j: %s", (server, expected) => {
    expect(isMailConnector(server)).toBe(expected);
    expect(runsHere(server)).toBe(expected);
  });

  it("a connector reached by its address is never one", () => {
    expect(isMailConnector({ type: "http", url: "https://imap.example.com/mcp", headers: {}, enabled: true })).toBe(false);
  });
});
