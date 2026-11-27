import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { draftRevision, type EmailDraftCardData } from "../shared/email-draft.ts";
import type { ConnectorCall } from "../shared/outbound.ts";
import {
  createDraftGuard, createEmailDraftRoutes, draftCardFrom, DraftRefused, showDraftAnswer, showDraftCard,
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
    const update: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-123", recipient_email: "ana@example.com", extra_recipients: [], cc: [], bcc: [], subject: "Launch v2", body: "New", is_html: false } };
    expect(draftCardFrom([update], answer("GMAIL_UPDATE_DRAFT", { successful: true, data: {} }), "b")).toMatchObject({ draftId: "r-123", subject: "Launch v2", body: "New" });
  });

  it("keeps what an update leaves out from the card already showing the draft, and shows none without one", () => {
    const before = { ...draftCardFrom([createCall], created(), "b")!, html: true as const, body: "<p>Hi</p>" };
    const update: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { user_id: "me", draft_id: "r-123", subject: "Launch v2" } };
    const done = answer("GMAIL_UPDATE_DRAFT", { successful: true, data: { id: "r-123" } });
    expect(draftCardFrom([update], done, "b", (id) => (id === "r-123" ? before : undefined))).toEqual({ ...before, subject: "Launch v2" });
    expect(draftCardFrom([update], done, "b")).toBeNull();
    expect(draftCardFrom([update], done, "b", () => undefined)).toBeNull();
  });

  it("keeps the recipients an update leaves out when it names only the first or only the others", () => {
    const before = draftCardFrom([createCall], created(), "b")!;
    const shownBefore = (id: string) => (id === "r-123" ? before : undefined);
    const done = answer("GMAIL_UPDATE_DRAFT", { successful: true, data: { id: "r-123" } });
    const firstOnly: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-123", recipient_email: "dee@example.com" } };
    expect(draftCardFrom([firstOnly], done, "b", shownBefore)?.to).toEqual(["dee@example.com", "ben@example.com"]);
    const othersOnly: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-123", extra_recipients: ["eve@example.com"] } };
    expect(draftCardFrom([othersOnly], done, "b", shownBefore)?.to).toEqual(["ana@example.com", "eve@example.com"]);
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

describe("showDraftAnswer when the card can't be written", () => {
  it("leaves the bot's finished call alone", () => {
    const store = { ...memoryStore(), appendMessage: () => { throw new Error("disk full"); } };
    expect(() => showDraftAnswer(store, "t1", "bot-1", [createCall], new TextEncoder().encode(JSON.stringify(created())), 7)).not.toThrow();
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
  const guard = createDraftGuard();
  const card: EmailDraftCardData = draftCardFrom([createCall], created(), "bot-1")!;
  const row = showDraftCard(store, "t1", card)!;
  const checked: ConnectorCall[][] = [];
  const route = createEmailDraftRoutes({
    store, guard, sees: () => true, inRoom: () => false, mayChat: () => true,
    connection: async (_auth, _bot, calls) => { checked.push(calls); return connection; }, ...over,
  });
  return { store, row, route, checked, guard };
}

const edit = { to: ["ana@example.com"], cc: [], bcc: ["boss@example.com"], subject: "Launch (final)", body: "Ready to go." };
/** The draft as the card shows it, which the confirmation names. */
const shownDraft = { to: ["ana@example.com", "ben@example.com"], cc: ["cy@example.com"], bcc: [], subject: "Launch", body: "Hi both,\nready." };
const confirmed = draftRevision(shownDraft);

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
    const first = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    await route(first.context);
    expect(first.sent.status).toBe(200);
    expect(ran).toEqual([{ slug: "GMAIL_SEND_DRAFT", account: "ca_work", arguments: { user_id: "me", draft_id: "r-123" } }]);
    expect(store.rows[0]!.emailDraft?.sentAt).toEqual(expect.any(Number));
    expect(store.rows[0]!.text).toBe('Email sent: "Launch" to ana@example.com, ben@example.com.');
    const again = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    await route(again.context);
    expect(again.sent.status).toBe(409);
    expect(ran).toHaveLength(1);
  });

  it("runs a double tap once", async () => {
    let open!: () => void;
    const { connection, ran, calling } = relayed(() => ({ successful: true, data: {} }), new Promise((resolve) => { open = resolve; }));
    const { row, route } = setup({}, connection);
    const first = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    const running = route(first.context);
    await calling;
    const second = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    await route(second.context);
    expect(second.sent.status).toBe(409);
    open();
    await running;
    expect(first.sent.status).toBe(200);
    expect(ran).toHaveLength(1);
  });

  it("runs nothing for someone who can't see the conversation or write to the bot, or in a room", async () => {
    for (const over of [{ sees: () => false }, { mayChat: () => false }, { inRoom: () => true }]) {
      for (const press of [{ action: "send", revision: confirmed }, { action: "save", draft: edit }]) {
        const { store, row, route, checked } = setup(over);
        const { context, sent } = request({ threadId: "t1", messageId: row.id, ...press });
        await route(context);
        expect(sent.status).toBe(404);
        expect(checked).toHaveLength(0);
        expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
      }
    }
  });

  it("sends nothing when the draft changed after the person confirmed it", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: {} }));
    const { store, row, route } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send", revision: draftRevision({ ...shownDraft, to: ["ana@example.com"] }) });
    await route(context);
    expect(sent.status).toBe(409);
    expect((sent.body as { errorKey: string }).errorKey).toBe("serverError.emailDraft.changed");
    expect(ran).toHaveLength(0);
    expect(store.rows[0]!.emailDraft?.sentAt).toBeUndefined();
  });

  it("saves and sends nothing when the bot's permissions change right before the call goes out", async () => {
    const refusal = { error: "Bot may not save or send Gmail drafts." };
    for (const press of [{ action: "send", revision: confirmed }, { action: "save", draft: edit }]) {
      // Allowed when the press is checked, then taken away while the call is being set up: the check right before the
      // tool call goes out refuses it, the way the server's relay does.
      let allowed = true;
      let checkedBeforeDispatch = 0;
      const { connection: gmail, ran } = relayed(() => ({ successful: true, data: { id: "r-123" } }));
      const connection: DraftConnection = { ok: true, relay: async (payload, session, signal) => {
        if ((payload as { method: string }).method === "initialize") allowed = false;
        if ((payload as { method: string }).method === "tools/call") { checkedBeforeDispatch++; if (!allowed) throw new DraftRefused(refusal); }
        return (gmail as Extract<DraftConnection, { ok: true }>).relay(payload, session, signal);
      } };
      const { store, row, route } = setup({}, connection);
      const { context, sent } = request({ threadId: "t1", messageId: row.id, ...press });
      await route(context);
      expect(sent).toEqual({ status: 403, body: refusal });
      expect(checkedBeforeDispatch).toBe(1);
      expect(ran).toHaveLength(0);
      expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
      expect(store.rows[0]!.emailDraft?.sentAt).toBeUndefined();
    }
  });

  it("sends nothing the bot changed in Gmail while Send was waiting for the draft", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: {} }));
    const { store, row, route, guard } = setup({}, connection);
    let finish!: () => void;
    const update: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { user_id: "me", draft_id: "r-123", recipient_email: "eve@example.com" } };
    // The bot's own update to the same draft is on its way to Gmail when the person presses Send.
    const botCall = guard.run(["r-123"], async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      showDraftAnswer(store, "t1", "bot-1", [update], new TextEncoder().encode(JSON.stringify(answer("GMAIL_UPDATE_DRAFT", { successful: true, data: { id: "r-123" } }))), 7, undefined, guard);
    });
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    const pressing = route(context);
    await Promise.resolve();
    expect(ran).toHaveLength(0);
    finish();
    await Promise.all([botCall, pressing]);
    expect(sent.status).toBe(409);
    expect((sent.body as { errorKey: string }).errorKey).toBe("serverError.emailDraft.changed");
    expect(ran).toHaveLength(0);
    expect(store.rows[0]!.emailDraft?.to).toEqual(["eve@example.com", "ben@example.com"]);
  });

  it("lets the bot's change to the draft wait until a Send already going out is done", async () => {
    let open!: () => void;
    const { connection, ran, calling } = relayed(() => ({ successful: true, data: {} }), new Promise((resolve) => { open = resolve; }));
    const { store, row, route, guard } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    const pressing = route(context);
    await calling;
    // The bot's call sees the card already sent, so it never changes the draft while Send is going out.
    const botCall = guard.run(["r-123"], async () => store.rows[0]!.emailDraft?.sentAt);
    open();
    await pressing;
    expect(await botCall).toEqual(expect.any(Number));
    expect(sent.status).toBe(200);
    expect(ran.map((one) => one.slug)).toEqual(["GMAIL_SEND_DRAFT"]);
    expect(store.rows[0]!.emailDraft?.sentAt).toEqual(expect.any(Number));
  });

  it("sends nothing after the bot changed the draft in Gmail but its card couldn't be updated, until the card shows it", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: {} }));
    const { store, row, route, guard } = setup({}, connection);
    const update: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { user_id: "me", draft_id: "r-123", subject: "Changed" } };
    const updated = new TextEncoder().encode(JSON.stringify(answer("GMAIL_UPDATE_DRAFT", { successful: true, data: { id: "r-123" } })));
    const broken = { ...store, patchMessage: () => { throw new Error("disk full"); } };
    await guard.run(["r-123"], async () => showDraftAnswer(broken, "t1", "bot-1", [update], updated, 7, undefined, guard));
    const first = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    await route(first.context);
    expect(first.sent.status).toBe(409);
    expect((first.sent.body as { errorKey: string }).errorKey).toBe("serverError.emailDraft.changed");
    expect(ran).toHaveLength(0);
    await guard.run(["r-123"], async () => showDraftAnswer(store, "t1", "bot-1", [update], updated, 7, undefined, guard));
    const again = request({ threadId: "t1", messageId: row.id, action: "send", revision: draftRevision({ ...shownDraft, subject: "Changed" }) });
    await route(again.context);
    expect(again.sent.status).toBe(200);
    expect(ran.map((one) => one.slug)).toEqual(["GMAIL_SEND_DRAFT"]);
  });

  it("says why when the Rules or the bot's app permissions refuse, and changes nothing", async () => {
    const { store, row, route } = setup({}, { ok: false, refusal: { error: "Your team's Rules don't allow Gmail." } });
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    await route(context);
    expect(sent).toEqual({ status: 403, body: { error: "Your team's Rules don't allow Gmail." } });
    expect(store.rows[0]!.emailDraft?.sentAt).toBeUndefined();
  });

  it("passes Gmail's refusal on and keeps the card live", async () => {
    const { connection } = relayed(() => ({ successful: false, error: "Requested entity was not found." }));
    const { store, row, route } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send", revision: confirmed });
    await route(context);
    expect(sent.status).toBe(502);
    expect((sent.body as { error: string }).error).toContain("Requested entity was not found.");
    expect(store.rows[0]!.emailDraft?.sentAt).toBeUndefined();
  });

  it("refuses a press it can't read", async () => {
    const { row, route, checked } = setup();
    for (const body of [{ threadId: "t1", messageId: row.id, action: "delete" }, { threadId: "t1", messageId: row.id, action: "save" }, { threadId: "t1", messageId: row.id, action: "send" }]) {
      const { context, sent } = request(body);
      await route(context);
      expect(sent.status).toBe(400);
    }
    expect(checked).toHaveLength(0);
  });
});
