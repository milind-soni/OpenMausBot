import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import type { EmailDraftCardData } from "../shared/email-draft.ts";
import type { ConnectorCall } from "../shared/outbound.ts";
import {
  createEmailDraftRoutes, draftCardFrom, showDraftAnswer, showDraftCard,
  type DraftCardStore, type DraftConnection, type EmailDraftRouteDeps,
} from "./email-draft-card.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import type { Message } from "./store.ts";

const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;

/** A multi-execute answer as the relay returns it. */
function answer(slug: string, response: Record<string, unknown>, id: unknown = 7): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response }] } }) }] } };
}

const created = (over: Record<string, unknown> = {}) => answer("GMAIL_CREATE_EMAIL_DRAFT", {
  successful: true, data: { id: "r-123", message: { id: "m-1", threadId: "th-9" }, display_url: "https://mail.google.com/mail/#drafts?compose=m-1", ...over },
});

const createCall: ConnectorCall = {
  slug: "GMAIL_CREATE_EMAIL_DRAFT", account: "ca_work",
  arguments: { user_id: "me", recipient_email: "ana@example.com", extra_recipients: ["ben@example.com"], cc: ["cy@example.com"], subject: "Launch", body: "Hi both,\nready." },
};

function memoryStore(): DraftCardStore & { rows: Message[] } {
  const rows: Message[] = [];
  let next = 0;
  return {
    rows,
    messagesFor: () => rows,
    appendMessage: (_thread, message) => { const row = { ...message, id: `m${++next}`, at: next } as Message; rows.push(row); return row; },
    patchMessage: (_thread, id, patch) => { const row = rows.find((one) => one.id === id); if (!row) return null; Object.assign(row, patch); return row; },
  };
}

describe("draftCardFrom", () => {
  it("reads the saved draft from the call and Gmail's answer", () => {
    expect(draftCardFrom([createCall], created(), "bot-1")).toEqual({
      app: "gmail", draftId: "r-123", botId: "bot-1", to: ["ana@example.com", "ben@example.com"], cc: ["cy@example.com"], bcc: [],
      subject: "Launch", body: "Hi both,\nready.", threadId: "th-9", account: "ca_work", url: "https://mail.google.com/mail/#drafts?compose=m-1",
    });
  });


  it("shows no card when the draft was not saved, or the batch is not one draft", () => {
    expect(draftCardFrom([createCall], answer("GMAIL_CREATE_EMAIL_DRAFT", { successful: false, error: "Invalid To header" }), "b")).toBeNull();
    expect(draftCardFrom([createCall], { jsonrpc: "2.0", id: 7, result: { isError: true, content: [{ type: "text", text: "refused" }] } }, "b")).toBeNull();
    expect(draftCardFrom([{ slug: "GMAIL_SEND_EMAIL", arguments: {} }], created(), "b")).toBeNull();
    expect(draftCardFrom([createCall, createCall], created(), "b")).toBeNull();
  });

  it("keeps only a plain https link to Gmail", () => {
    expect(draftCardFrom([createCall], created({ display_url: "javascript:alert(1)" }), "b")?.url).toBeUndefined();
    expect(draftCardFrom([createCall], created({ display_url: "https://user:pw@mail.google.com/" }), "b")?.url).toBeUndefined();
  });

  it("keeps the draft id of an update that answers without one", () => {
    const update: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-123", recipient_email: "ana@example.com", subject: "Launch v2", body: "New" } };
    expect(draftCardFrom([update], answer("GMAIL_UPDATE_DRAFT", { successful: true, data: {} }), "b")).toMatchObject({ draftId: "r-123", subject: "Launch v2", body: "New" });
  });
});

describe("showDraftAnswer", () => {
  const bytesOf = (frame: unknown) => new TextEncoder().encode(JSON.stringify(frame));

  it("shows the card from an event-stream answer, and nothing from one it can't read", () => {
    const store = memoryStore();
    showDraftAnswer(store, "t1", "bot-1", [createCall], new TextEncoder().encode("{not json"), 7);
    expect(store.rows).toHaveLength(0);
    showDraftAnswer(store, "t1", "bot-1", [createCall], new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(created())}\n\n`), 7);
    expect(store.rows.map((row) => row.emailDraft?.draftId)).toEqual(["r-123"]);
  });

  it("turns the card into what was sent when the bot sends that draft itself", () => {
    const store = memoryStore();
    showDraftAnswer(store, "t1", "bot-1", [createCall], bytesOf(created()), 7);
    const send: ConnectorCall = { slug: "GMAIL_SEND_DRAFT", arguments: { user_id: "me", draft_id: "r-123" } };
    showDraftAnswer(store, "t1", "bot-2", [send], bytesOf(answer("GMAIL_SEND_DRAFT", { successful: true, data: { id: "m-1" } })), 7);
    expect(store.rows[0].emailDraft?.sentAt).toBeUndefined();
    showDraftAnswer(store, "t1", "bot-1", [send], bytesOf(answer("GMAIL_SEND_DRAFT", { successful: false, error: "Not found" })), 7);
    expect(store.rows[0].emailDraft?.sentAt).toBeUndefined();
    showDraftAnswer(store, "t1", "bot-1", [send], bytesOf(answer("GMAIL_SEND_DRAFT", { successful: true, data: { id: "m-1" } })), 7);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].emailDraft?.sentAt).toEqual(expect.any(Number));
    expect(store.rows[0].text).toBe('Email sent: "Launch" to ana@example.com, ben@example.com.');
  });
});

describe("showDraftCard", () => {
  it("updates the card already showing that draft instead of adding another", () => {
    const store = memoryStore();
    const card = draftCardFrom([createCall], created(), "bot-1")!;
    showDraftCard(store, "t1", card);
    showDraftCard(store, "t1", { ...card, subject: "Launch v2" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ role: "bot", serverCard: true, text: 'Draft saved in Gmail: "Launch v2" to ana@example.com, ben@example.com.' });
    expect(store.rows[0]!.emailDraft?.subject).toBe("Launch v2");
  });
});

function request(body: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const res = Object.assign(new EventEmitter(), { writableFinished: false, writableEnded: false, destroyed: false });
  const context = { req: {} as RouteContext["req"], res: res as unknown as RouteContext["res"], url: new URL("http://x/api/email-draft"), path: "/api/email-draft", method: "POST", auth,
    json: ((_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as unknown as RouteContext["json"],
    readBody: (async () => body) as unknown as RouteContext["readBody"] } as RouteContext;
  return { context, sent };
}

/** A connection whose tool calls answer `reply`, recording every call it ran. */
function relayed(reply: (slug: string) => Record<string, unknown>, gate?: Promise<void>) {
  const ran: Array<{ slug: string; arguments: unknown; account?: string }> = [];
  let started!: () => void;
  const calling = new Promise<void>((resolve) => { started = resolve; });
  const connection: DraftConnection = {
    ok: true,
    relay: async (payload) => {
      const frame = payload as { id?: unknown; method: string; params?: { arguments?: { tools?: Array<{ tool_slug: string; arguments: unknown; account?: string }> } } };
      if (frame.method === "initialize") return { status: 200, bytes: new Uint8Array(), transportSessionId: "s1" };
      if (frame.method !== "tools/call") return { status: 202, bytes: new Uint8Array() };
      const tool = frame.params!.arguments!.tools![0]!;
      ran.push({ slug: tool.tool_slug, arguments: tool.arguments, ...(tool.account ? { account: tool.account } : {}) });
      started();
      await gate;
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(answer(tool.tool_slug, reply(tool.tool_slug), frame.id))) };
    },
  };
  return { connection, ran, calling };
}

function setup(over: Partial<EmailDraftRouteDeps> = {}, connection: DraftConnection = relayed(() => ({ successful: true, data: { id: "r-123" } })).connection) {
  const store = memoryStore();
  const card: EmailDraftCardData = draftCardFrom([createCall], created(), "bot-1")!;
  const row = showDraftCard(store, "t1", card)!;
  const checked: ConnectorCall[][] = [];
  const route = createEmailDraftRoutes({
    store, sees: () => true, mayChat: () => true,
    connection: async (_auth, _bot, calls) => { checked.push(calls); return connection; }, ...over,
  });
  return { store, row, route, checked };
}

const edit = { to: ["ana@example.com"], cc: [], bcc: ["boss@example.com"], subject: "Launch (final)", body: "Ready to go." };

describe("POST /api/email-draft", () => {
  it("saves an edit to the same draft in the same account, then shows it", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: { id: "r-123", message: { id: "m-2" } } }));
    const { store, row, route, checked } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "save", draft: edit });
    await route(context);
    expect(sent.status).toBe(200);
    expect(ran).toEqual([{ slug: "GMAIL_UPDATE_DRAFT", account: "ca_work", arguments: {
      user_id: "me", draft_id: "r-123", recipient_email: "ana@example.com", extra_recipients: [], cc: [], bcc: ["boss@example.com"],
      subject: "Launch (final)", body: "Ready to go.", is_html: false, thread_id: "th-9",
    } }]);
    expect(checked[0]![0]!.slug).toBe("GMAIL_UPDATE_DRAFT");
    expect(store.rows[0]!.emailDraft).toMatchObject({ ...edit, draftId: "r-123" });
    expect(store.rows[0]!.text).toBe('Draft saved in Gmail: "Launch (final)" to ana@example.com.');
  });

  it("sends the draft once, and the card then only shows what was sent", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: { id: "m-3", labelIds: ["SENT"] } }));
    const { store, row, route } = setup({}, connection);
    const first = request({ threadId: "t1", messageId: row.id, action: "send" });
    await route(first.context);
    expect(first.sent.status).toBe(200);
    expect(ran).toEqual([{ slug: "GMAIL_SEND_DRAFT", account: "ca_work", arguments: { user_id: "me", draft_id: "r-123" } }]);
    expect(store.rows[0]!.emailDraft?.sentAt).toEqual(expect.any(Number));
    expect(store.rows[0]!.text).toBe('Email sent: "Launch" to ana@example.com, ben@example.com.');
    const again = request({ threadId: "t1", messageId: row.id, action: "send" });
    await route(again.context);
    expect(again.sent.status).toBe(409);
    expect(ran).toHaveLength(1);
  });

  it("runs a double tap once", async () => {
    let open!: () => void;
    const { connection, ran, calling } = relayed(() => ({ successful: true, data: {} }), new Promise((resolve) => { open = resolve; }));
    const { row, route } = setup({}, connection);
    const first = request({ threadId: "t1", messageId: row.id, action: "send" });
    const running = route(first.context);
    await calling;
    const second = request({ threadId: "t1", messageId: row.id, action: "send" });
    await route(second.context);
    expect(second.sent.status).toBe(409);
    open();
    await running;
    expect(first.sent.status).toBe(200);
    expect(ran).toHaveLength(1);
  });

  it("runs nothing for someone who can't see the conversation or write to the bot", async () => {
    for (const over of [{ sees: () => false }, { mayChat: () => false }]) {
      const { row, route, checked } = setup(over);
      const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send" });
      await route(context);
      expect(sent.status).toBe(404);
      expect(checked).toHaveLength(0);
    }
  });

  it("says why when the Rules or the bot's app permissions refuse, and changes nothing", async () => {
    const { store, row, route } = setup({}, { ok: false, refusal: { error: "Your team's Rules don't allow Gmail." } });
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send" });
    await route(context);
    expect(sent).toEqual({ status: 403, body: { error: "Your team's Rules don't allow Gmail." } });
    expect(store.rows[0]!.emailDraft?.sentAt).toBeUndefined();
  });

  it("passes Gmail's refusal on and keeps the card live", async () => {
    const { connection } = relayed(() => ({ successful: false, error: "Requested entity was not found." }));
    const { store, row, route } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send" });
    await route(context);
    expect(sent.status).toBe(502);
    expect((sent.body as { error: string }).error).toContain("Requested entity was not found.");
    expect(store.rows[0]!.emailDraft?.sentAt).toBeUndefined();
  });

  it("refuses a press it can't read", async () => {
    const { row, route, checked } = setup();
    for (const body of [{ threadId: "t1", messageId: row.id, action: "delete" }, { threadId: "t1", messageId: row.id, action: "save" }, { threadId: "t1", messageId: row.id, action: "send", draft: edit }]) {
      const { context, sent } = request(body);
      await route(context);
      expect(sent.status).toBe(400);
    }
    expect(checked).toHaveLength(0);
  });
});
