import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import { setConversationLanguage } from "../server-lines.ts";
import { boxUploadsDir } from "../bot-box/plan.ts";
import { EmailError, openGuard, SendingError } from "./client.ts";
import { outsideRouteRefused } from "../host/outside-fence.ts";
import { createEmailHost, EMAIL_INTERNAL_MCP_PATH, emailAccess, emailAllowedFor, type EmailBot, type EmailHostDeps } from "./host.ts";
import { createEmailService } from "./service.ts";
import type { EmailToolResult } from "./tools.ts";
import { EMAIL_READ_TOOL_NAMES, EMAIL_TOOL_NAMES } from "../../shared/email.ts";

const PASSWORD = "fake-mailbox-password-1";
const dirs: string[] = [];
// The decision log is appended to after a call answers, so a folder may still be written as it goes.
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

async function fixture(run: EmailHostDeps["run"] = {}, bot: EmailBot | null = { id: "b1", name: "Ada", color: "blue" }, connected = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-mail-host-")); dirs.push(dataDir);
  const service = createEmailService({ dataDir, publicOnly: false, guard: openGuard, discover: { fetchText: async () => null, mx: async () => [], srv: async () => [], cname: async () => [], reverse: async () => [] }, test: { mailbox: (async () => ({ messages: 1 })) as never, sending: (async () => {}) as never } });
  if (connected) await service.connect({ address: "me@shop.example", password: PASSWORD });
  const marked: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const host = createEmailHost({ service, dataDir, bot: () => bot, inRoom: () => false, appendMessage: (_thread, message) => rows.push(message), markOutside: (threadId) => marked.push(threadId), run });
  const call = (name: string, args: Record<string, unknown> = {}) => host.handle({ method: "tools/call", params: { name, arguments: args } }, { botId: "b1", threadId: "t1" }, () => {}) as Promise<EmailToolResult>;
  return { host, service, marked, rows, call, dataDir };
}

const ALL_READS = {
  listMailboxes: async () => [{ path: "INBOX" }],
  listMessages: async () => ({ total: 1, messages: [] }),
  searchMessages: async () => ({ found: 0, messages: [] }),
  readMessage: async () => ({ uid: 9, from: "x", to: [], subject: "s", date: null, unread: true, cc: [], replyTo: [], text: "hello", truncated: false, attachments: [] }),
};

describe("a turn's Email tools", () => {
  it("saved attachments go with their conversation, and with their bot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mail-host-")); dirs.push(dataDir);
    const service = createEmailService({ dataDir, publicOnly: false, guard: openGuard });
    let change: (event: { type: string; threadId?: string; botId?: string }) => void = () => {};
    createEmailHost({ service, dataDir, bot: () => null, inRoom: () => false, appendMessage: () => {}, markOutside: () => {}, onChange: (listener) => { change = listener; } });
    const file = (bot: string, thread: string) => { const folder = boxUploadsDir(dataDir, bot, thread); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "a.pdf"), "x"); return join(folder, "a.pdf"); };
    const [one, two, three] = [file("b1", "t1"), file("b1", "t2"), file("b2", "t3")];
    change({ type: "thread.deleted", threadId: "t1" });
    expect([existsSync(one), existsSync(two), existsSync(three)]).toEqual([false, true, true]);
    change({ type: "bot.deleted", botId: "b2" });
    expect([existsSync(one), existsSync(two), existsSync(three)]).toEqual([false, true, false]);
    change({ type: "thread.deleted", threadId: "../../secrets" });
    expect(existsSync(two)).toBe(true);
  });

  it("every read marks the conversation as outside work, before the mail comes back", async () => {
    for (const name of EMAIL_READ_TOOL_NAMES) {
      let markedFirst = false;
      const { marked, call } = await fixture({ ...ALL_READS, ...(name === "EMAIL_READ_MESSAGE" ? { readMessage: (async () => { markedFirst = marked.length === 1; return ALL_READS.readMessage(); }) as never } : {}) });
      const answer = await call(name, name === "EMAIL_READ_MESSAGE" ? { uid: 9 } : {});
      expect(answer.isError, name).toBeUndefined();
      expect(marked, name).toEqual(["t1"]);
      if (name === "EMAIL_READ_MESSAGE") expect(markedFirst).toBe(true);
    }
  });

  it("a read that fails halfway still leaves the conversation marked", async () => {
    const { marked, call } = await fixture({ listMessages: (async () => { throw new EmailError("network", "gone"); }) as never });
    expect((await call("EMAIL_LIST_MESSAGES")).isError).toBe(true);
    expect(marked).toEqual(["t1"]);
  });

  it("sending marks nothing, reports only how many it went to, and shows one row", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const { marked, rows, call } = await fixture({ sendMessage: (async (_a: unknown, _g: unknown, input: Record<string, unknown>) => { sent.push(input); return { messageId: "<1@x>", accepted: ["a@b.example"], rejected: [], filed: true }; }) as never });
    const answer = await call("EMAIL_SEND_MESSAGE", { to: ["a@b.example"], subject: "Hi", text: "Body" });
    expect(answer.isError).toBeUndefined();
    expect(sent).toEqual([{ to: ["a@b.example"], subject: "Hi", text: "Body" }]);
    expect(marked).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("a@b.example");
    expect(JSON.stringify(rows)).not.toContain("Body");
  });

  it("a send the outgoing server refuses for good stops sends until the person fixes it; one that may pass doesn't", async () => {
    const server = { host: "smtp.shop.example", port: 587, secure: false };
    let fault: "password" | "no-answer" = "no-answer";
    let calls = 0;
    const { call, service, host } = await fixture({ sendMessage: (async () => { calls++; throw new SendingError(fault, server); }) as never });
    const send = () => call("EMAIL_SEND_MESSAGE", { to: ["a@b.example"], subject: "Hi", text: "Body" });
    const passing = await send();
    expect(passing).toMatchObject({ isError: true });
    expect(passing.content[0]!.text).toContain("smtp.shop.example didn't answer on port 587.");
    expect(service.sendingProblem("me@shop.example")).toBeUndefined();
    fault = "password";
    const lasting = await send();
    expect(lasting.content[0]!.text).toContain("The outgoing server smtp.shop.example:587 refused the password.");
    expect(lasting.content[0]!.text).toContain("Connected apps");
    expect(lasting.content[0]!.text).not.toMatch(/try again/iu);
    expect(service.sendingProblem("me@shop.example")).toContain("refused the password");
    expect((await send()).isError).toBe(true);
    expect(calls, "the third send never reached the server").toBe(2);
    expect(host.prompt({ id: "b1", name: "Ada" })).toContain("Sending from me@shop.example doesn't work until the person fixes its outgoing server");
  });

  it("a header can't be smuggled into a send", async () => {
    let sent = 0;
    const { call } = await fixture({ sendMessage: (async () => { sent++; return { messageId: "<1@x>", accepted: [], rejected: [], filed: false }; }) as never });
    expect((await call("EMAIL_SEND_MESSAGE", { to: ["a@b.example"], subject: "Hi\r\nBcc: evil@x.example", text: "Body" })).isError).toBe(true);
    expect((await call("EMAIL_SEND_MESSAGE", { to: ["a@b.example\r\nBcc: evil@x.example"], subject: "Hi", text: "Body" })).isError).toBe(true);
    expect(sent, "nothing went").toBe(0);
  });

  it("no answer ever holds the password, even when a call fails", async () => {
    const { call, service } = await fixture({ listMessages: (async () => { throw new EmailError("password", `refused ${PASSWORD}`); }) as never });
    const answer = await call("EMAIL_LIST_MESSAGES");
    expect(JSON.stringify(answer)).not.toContain(PASSWORD);
    expect(answer.content[0]!.text).toContain("request_credential");
    expect(service.status().accounts[0]?.problem, "the Apps card says it needs them").toContain("stopped accepting");
  });

  it("an unconnected turn is told how to ask, and asks for a mailbox by name when there are several", async () => {
    const empty = await fixture({}, undefined, false);
    expect((await empty.call("EMAIL_LIST_MESSAGES")).content[0]!.text).toContain("request_credential");
    expect(empty.marked, "nothing read, nothing marked").toEqual([]);
    const two = await fixture(ALL_READS);
    await two.service.connect({ address: "two@shop.example", password: PASSWORD });
    expect((await two.call("EMAIL_LIST_MESSAGES")).content[0]!.text).toContain("Say which mailbox");
    expect((await two.call("EMAIL_LIST_MESSAGES", { account: "two@shop.example" })).isError).toBeUndefined();
    expect((await two.call("EMAIL_LIST_MESSAGES", { account: "other@shop.example" })).content[0]!.text).toContain("No mailbox other@shop.example");
  });

  it("re-reads the bot on every call: a bot gone or narrowed is refused, before any mail is read", async () => {
    const gone = await fixture(ALL_READS, null);
    expect((await gone.call("EMAIL_LIST_MESSAGES")).content[0]!.text).toBe("This bot no longer exists.");
    expect(gone.marked).toEqual([]);
  });

  it("a read-only bot reads and can't send; a bot with connected apps off gets neither", async () => {
    const reader = { id: "b", name: "Ada", connectorScopes: { apps: { email: "read" as const } } };
    expect(EMAIL_TOOL_NAMES.filter((name) => emailAccess(reader, name).ok)).toEqual(EMAIL_READ_TOOL_NAMES);
    expect(emailAllowedFor({ composio: false })).toBe(false);
    expect(emailAllowedFor({ connectorScopes: { apps: { gmail: "write" as const } } })).toBe(false);
    expect(emailAllowedFor({ connectorTools: { gmail: { tools: "*" } } })).toBe(false);
    expect(emailAllowedFor({})).toBe(true);
    const list = await (await fixture({}, reader)).host.handle({ method: "tools/list" }, { botId: "b", threadId: "t" }, () => {}) as { tools: Array<{ name: string }> };
    expect(list.tools.map((tool) => tool.name)).toEqual(EMAIL_READ_TOOL_NAMES);
  });

  it("a confined turn still reaches its tools, which the engine asks a person about first", () => {
    expect(outsideRouteRefused("POST", EMAIL_INTERNAL_MCP_PATH)).toBe(false);
  });

  it("each tool says whether it only reads, which is what an engine's normal approval goes by", async () => {
    const { host } = await fixture();
    const { tools } = await host.handle({ method: "tools/list" }, { botId: "b1", threadId: "t1" }, () => {}) as unknown as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    expect(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(EMAIL_READ_TOOL_NAMES);
    expect(tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(["EMAIL_SEND_MESSAGE"]);
  });

  it("a turn no longer active is refused before anything runs", async () => {
    const { host, marked } = await fixture(ALL_READS);
    await expect(host.handle({ method: "tools/call", params: { name: "EMAIL_LIST_MESSAGES", arguments: {} } }, { botId: "b1", threadId: "t1" }, () => { throw new Error("ended"); })).rejects.toThrow("ended");
    expect(marked).toEqual([]);
  });

  it("mounts only while a mailbox is connected, and its prompt says how to ask otherwise", async () => {
    const empty = await fixture({}, undefined, false);
    expect(empty.host.integration({ id: "b", name: "A" }, () => "t", "http://127.0.0.1:1")).toBeNull();
    expect(empty.host.prompt({ id: "b", name: "A" })).toContain("credential_id email");
    const { host } = await fixture();
    const mount = host.integration({ id: "b", name: "A" }, () => "cap", "http://127.0.0.1:1")!;
    expect(mount.args.at(-1)).toBe("email");
    expect(mount.env.OMB_MCP_TOKEN_EMAIL).toBe("cap");
    expect(JSON.stringify(mount)).not.toContain(PASSWORD);
    expect(host.prompt({ id: "b", name: "A" })).toContain("me@shop.example");
    expect(host.prompt({ id: "b", name: "A" })).not.toContain(PASSWORD);
    expect(host.prompt({ id: "b", name: "A", composio: false })).toBe("");
  });
});

it.each([
  ["en", "Sent from me@shop.example to 1 recipient(s)"],
  ["pt-br", "Enviado de me@shop.example. Destinatários: 1"],
  ["de", "Von me@shop.example an 1 Empfänger gesendet"],
])("the send activity uses the conversation's language %s", async (language, summary) => {
  setConversationLanguage(() => language);
  try {
    const { rows, call } = await fixture({ sendMessage: (async () => ({ messageId: "<1@x>", accepted: ["a@b.example"], rejected: [], filed: true })) as never });
    await call("EMAIL_SEND_MESSAGE", { to: ["a@b.example"], subject: "Hi", text: "Body" });
    expect(rows[0]).toMatchObject({ tool: { summary } });
    expect(JSON.stringify(rows)).not.toContain("a@b.example");
  } finally { setConversationLanguage(() => undefined); }
});
