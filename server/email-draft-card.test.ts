import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import type { EmailDraftCardData, EmailDraftEdit } from "../shared/email-draft.ts";
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

  it("shows no card for a draft with other recipients but no first one, so a later update can't drop them", () => {
    const before = draftCardFrom([createCall], created(), "b")!;
    const done = answer("GMAIL_UPDATE_DRAFT", { successful: true, data: { id: "r-123" } });
    const cleared: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-123", recipient_email: "" } };
    expect(draftCardFrom([cleared], done, "b", (id) => (id === "r-123" ? before : undefined))).toBeNull();
    const othersOnly: ConnectorCall = { slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { user_id: "me", extra_recipients: ["ben@example.com"], subject: "Launch", body: "Hi" } };
    expect(draftCardFrom([othersOnly], created(), "b")).toBeNull();
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


/** Composio's GMAIL_GET_DRAFT answer for a draft Gmail holds: its headers, as Gmail writes them, and its text. */
function heldAnswer(draft: EmailDraftEdit, over: Record<string, unknown> = {}): Record<string, unknown> {
  const fields: Array<[string, readonly string[]]> = [["To", draft.to], ["Cc", draft.cc], ["Bcc", draft.bcc], ["Subject", [draft.subject]]];
  const headers = fields.filter(([, values]) => values.some(Boolean)).map(([name, values]) => ({ name, value: values.join(", ") }));
  return { successful: true, data: { id: "r-123", message: { to: draft.to.join(", "), subject: draft.subject, messageText: draft.body, payload: { headers }, ...over } } };
}

/** A connection to a Gmail holding `gmail`: reading the draft answers what it holds, other tool calls answer `reply` (an
 *  update that succeeds changes what it holds). It records every call it ran. */
function relayed(reply: (slug: string) => Record<string, unknown>, gate?: Promise<void>, gmail: EmailDraftEdit = { ...shownDraft }) {
  const ran: Array<{ slug: string; arguments: unknown; account?: string }> = [];
  let started!: () => void;
  const calling = new Promise<void>((resolve) => { started = resolve; });
  const connection: DraftConnection = {
    ok: true,
    relay: async (payload, _session, _signal, beforeSend) => {
      const frame = payload as { id?: unknown; method: string; params?: { arguments?: { tools?: Array<{ tool_slug: string; arguments: unknown; account?: string }> } } };
      if (frame.method === "initialize") return { status: 200, bytes: new Uint8Array(), transportSessionId: "s1" };
      if (frame.method !== "tools/call") return { status: 202, bytes: new Uint8Array() };
      const tool = frame.params!.arguments!.tools![0]!;
      beforeSend?.();
      ran.push({ slug: tool.tool_slug, arguments: tool.arguments, ...(tool.account ? { account: tool.account } : {}) });
      started();
      await gate;
      const args = tool.arguments as Record<string, unknown>;
      const result = tool.tool_slug === "GMAIL_GET_DRAFT" ? heldAnswer(gmail) : reply(tool.tool_slug);
      if (tool.tool_slug === "GMAIL_UPDATE_DRAFT" && result.successful) {
        Object.assign(gmail, { to: [args.recipient_email, ...(args.extra_recipients as string[])].filter(Boolean), cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body });
      }
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(answer(tool.tool_slug, result, frame.id))) };
    },
  };
  return { connection, ran, calling, gmail };
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
/** The draft as the card shows it. */
const shownDraft = { to: ["ana@example.com", "ben@example.com"], cc: ["cy@example.com"], bcc: [], subject: "Launch", body: "Hi both,\nready." };
const save = { action: "save", base: shownDraft, draft: edit };
const READ = { slug: "GMAIL_GET_DRAFT", account: "ca_work", arguments: { user_id: "me", draft_id: "r-123", format: "full" } };
const errorKey = (sent: { body?: unknown }) => (sent.body as { errorKey?: string }).errorKey;
type Relay = Extract<DraftConnection, { ok: true }>;

describe("POST /api/email-draft", () => {
  it("saves an edit to the same draft in the same account, then shows it", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: { id: "r-123", message: { id: "m-2" } } }));
    const { store, row, route, checked } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    await route(context);
    expect(sent.status).toBe(200);
    expect(ran).toEqual([READ, { slug: "GMAIL_UPDATE_DRAFT", account: "ca_work", arguments: {
      user_id: "me", draft_id: "r-123", recipient_email: "ana@example.com", extra_recipients: [], cc: [], bcc: ["boss@example.com"],
      subject: "Launch (final)", body: "Ready to go.", is_html: false, thread_id: "th-9",
    } }]);
    expect(checked[0]!.map((call) => call.slug)).toEqual(["GMAIL_GET_DRAFT", "GMAIL_UPDATE_DRAFT"]);
    expect(store.rows[0]!.emailDraft).toMatchObject({ ...edit, draftId: "r-123" });
    expect(store.rows[0]!.text).toBe('Draft saved in Gmail: "Launch (final)" to ana@example.com.');
  });

  it("has no Send: a press to send is refused and nothing goes to Gmail", async () => {
    const { store, row, route, checked } = setup();
    const { context, sent } = request({ threadId: "t1", messageId: row.id, action: "send", revision: "abc" });
    await route(context);
    expect(sent.status).toBe(400);
    expect(checked).toHaveLength(0);
    expect(store.rows[0]!.emailDraft?.sentAt).toBeUndefined();
  });

  it("saves nothing once the bot sent the draft", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: { id: "r-123" } }));
    const { store, row, route } = setup({}, connection);
    showDraftAnswer(store, "t1", "bot-1", [{ slug: "GMAIL_SEND_DRAFT", arguments: { user_id: "me", draft_id: "r-123" } }],
      new TextEncoder().encode(JSON.stringify(answer("GMAIL_SEND_DRAFT", { successful: true, data: { id: "m-1" } }))), 7);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    await route(context);
    expect(sent.status).toBe(409);
    expect(errorKey(sent)).toBe("serverError.emailDraft.alreadySent");
    expect(ran).toHaveLength(0);
  });

  it("runs a double tap once", async () => {
    let open!: () => void;
    const { connection, ran, calling } = relayed(() => ({ successful: true, data: { id: "r-123" } }), new Promise((resolve) => { open = resolve; }));
    const { row, route } = setup({}, connection);
    const first = request({ threadId: "t1", messageId: row.id, ...save });
    const running = route(first.context);
    await calling;
    const second = request({ threadId: "t1", messageId: row.id, ...save });
    await route(second.context);
    expect(second.sent.status).toBe(409);
    expect(errorKey(second.sent)).toBe("serverError.emailDraft.busy");
    open();
    await running;
    expect(first.sent.status).toBe(200);
    expect(ran.map((one) => one.slug)).toEqual(["GMAIL_GET_DRAFT", "GMAIL_UPDATE_DRAFT"]);
  });

  it("runs nothing for someone who can't see the conversation or write to the bot, or in a room", async () => {
    for (const over of [{ sees: () => false }, { mayChat: () => false }, { inRoom: () => true }]) {
      const { store, row, route, checked } = setup(over);
      const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
      await route(context);
      expect(sent.status).toBe(404);
      expect(checked).toHaveLength(0);
      expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
    }
  });

  it("saves nothing when the bot's permissions change right before the call goes out", async () => {
    const refusal = { error: "Bot may not save Gmail drafts." };
    // Allowed when the press is checked, then taken away while the call is being set up: the check right before the
    // tool call goes out refuses it, the way the server's relay does.
    let allowed = true;
    let checkedBeforeDispatch = 0;
    const { connection: gmail, ran } = relayed(() => ({ successful: true, data: { id: "r-123" } }));
    const connection: DraftConnection = { ok: true, relay: async (payload, session, signal, beforeSend) => {
      if ((payload as { method: string }).method === "initialize") allowed = false;
      if ((payload as { method: string }).method === "tools/call") { checkedBeforeDispatch++; if (!allowed) throw new DraftRefused(refusal); }
      return (gmail as Relay).relay(payload, session, signal, beforeSend);
    } };
    const { store, row, route } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    await route(context);
    expect(sent).toEqual({ status: 403, body: refusal });
    expect(checkedBeforeDispatch).toBe(1);
    expect(ran).toHaveLength(0);
    expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
  });

  it("waits for the bot's call to the same draft, then saves nothing over the bot's change and shows it", async () => {
    const { connection, ran, gmail } = relayed(() => ({ successful: true, data: { id: "r-123" } }));
    const { store, row, route, guard } = setup({}, connection);
    let finish!: () => void;
    const update: ConnectorCall = { slug: "GMAIL_UPDATE_DRAFT", arguments: { user_id: "me", draft_id: "r-123", subject: "From the bot" } };
    // The bot's own update to the same draft is on its way to Gmail when the person presses Save.
    const botCall = guard.run(["r-123"], async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      gmail.subject = "From the bot";
      showDraftAnswer(store, "t1", "bot-1", [update], new TextEncoder().encode(JSON.stringify(answer("GMAIL_UPDATE_DRAFT", { successful: true, data: { id: "r-123" } }))), 7);
    });
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    const pressing = route(context);
    await Promise.resolve();
    expect(ran).toHaveLength(0);
    finish();
    await Promise.all([botCall, pressing]);
    // The edit started from the card before the bot's change: saving every field would undo it.
    expect(sent.status).toBe(409);
    expect(errorKey(sent)).toBe("serverError.emailDraft.changed");
    expect(ran.map((one) => one.slug)).toEqual(["GMAIL_GET_DRAFT"]);
    expect(gmail.subject).toBe("From the bot");
    expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, subject: "From the bot", draftId: "r-123" });
  });

  it("says why when the Rules or the bot's app permissions refuse, and changes nothing", async () => {
    const { store, row, route } = setup({}, { ok: false, refusal: { error: "Your team's Rules don't allow Gmail." } });
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    await route(context);
    expect(sent).toEqual({ status: 403, body: { error: "Your team's Rules don't allow Gmail." } });
    expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
  });

  it("passes Gmail's refusal on and keeps the card live", async () => {
    const { connection } = relayed(() => ({ successful: false, error: "Requested entity was not found." }));
    const { store, row, route } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    await route(context);
    expect(sent.status).toBe(502);
    expect((sent.body as { error: string }).error).toContain("Requested entity was not found.");
    expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
  });

  it("refuses a press it can't read", async () => {
    const { row, route, checked } = setup();
    for (const body of [{ threadId: "t1", messageId: row.id, action: "delete" }, { threadId: "t1", messageId: row.id, action: "save" }]) {
      const { context, sent } = request(body);
      await route(context);
      expect(sent.status).toBe(400);
    }
    expect(checked).toHaveLength(0);
  });

  it("runs nothing when the person loses the conversation or the bot while the call is being set up", async () => {
    for (const lose of ["sees", "mayChat", "inRoom"] as const) {
      // Lost during the handshake, or during the relay's own setup right before the tool call (a session it awaits).
      for (const when of ["initialize", "tools/call"]) {
        let lost = false;
        const { connection: gmail, ran } = relayed(() => ({ successful: true, data: { id: "r-123" } }));
        const connection: DraftConnection = { ok: true, relay: async (payload, session, signal, beforeSend) => {
          if ((payload as { method: string }).method === when) lost = true;
          return (gmail as Relay).relay(payload, session, signal, beforeSend);
        } };
        const { store, row, route } = setup({
          sees: () => !(lost && lose === "sees"), mayChat: () => !(lost && lose === "mayChat"), inRoom: () => lost && lose === "inRoom",
        }, connection);
        const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
        await route(context);
        expect(sent.status).toBe(404);
        expect(errorKey(sent)).toBe("serverError.emailDraft.notHere");
        expect(ran).toHaveLength(0);
        expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
      }
    }
  });

  it("saves nothing when Gmail changed since the edit started, and shows what Gmail holds instead", async () => {
    const changed = { ...shownDraft, to: ["ana@example.com", "Zoe Z <zoe@example.com>"], body: "Changed in Gmail." };
    const { connection, ran, gmail } = relayed(() => ({ successful: true, data: { id: "r-123" } }), undefined, { ...changed });
    const { store, row, route } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    await route(context);
    expect(sent.status).toBe(409);
    expect(errorKey(sent)).toBe("serverError.emailDraft.changed");
    expect(ran).toEqual([READ]);
    expect(gmail).toEqual(changed);
    // The card keeps addresses only, as Save sends them to Gmail as addresses.
    expect(store.rows[0]!.emailDraft).toMatchObject({ ...changed, to: ["ana@example.com", "zoe@example.com"], draftId: "r-123" });
    expect(store.rows[0]!.text).toBe('Draft saved in Gmail: "Launch" to ana@example.com, zoe@example.com.');
  });

  it("keeps a recipient change saved from another conversation's card when an older card saves later", async () => {
    // Two conversations show the same draft. B saves new recipients; A's card still shows the old ones.
    const threads = new Map<string, Message[]>([["tA", []], ["tB", []]]);
    let next = 0;
    const store: DraftCardStore = {
      messagesFor: (thread) => threads.get(thread)!,
      appendMessage: (thread, message) => { const row = { ...message, id: `m${++next}`, at: next } as Message; threads.get(thread)!.push(row); return row; },
      patchMessage: (thread, id, patch) => { const row = threads.get(thread)!.find((one) => one.id === id); if (!row) return null; Object.assign(row, patch); return row; },
    };
    const card = draftCardFrom([createCall], created(), "bot-1")!;
    const rowA = showDraftCard(store, "tA", card)!;
    const rowB = showDraftCard(store, "tB", card)!;
    const { connection, ran, gmail } = relayed(() => ({ successful: true, data: { id: "r-123" } }));
    const route = createEmailDraftRoutes({ store, guard: createDraftGuard(), sees: () => true, inRoom: () => false, mayChat: () => true, connection: async () => connection });
    const fromB = request({ threadId: "tB", messageId: rowB.id, action: "save", base: shownDraft, draft: { ...shownDraft, to: ["ana@example.com", "dan@example.com"] } });
    await route(fromB.context);
    expect(fromB.sent.status).toBe(200);
    const fromA = request({ threadId: "tA", messageId: rowA.id, action: "save", base: shownDraft, draft: { ...shownDraft, subject: "Launch (typo fixed)" } });
    await route(fromA.context);
    expect(fromA.sent.status).toBe(409);
    expect(errorKey(fromA.sent)).toBe("serverError.emailDraft.changed");
    expect(ran.map((one) => one.slug)).toEqual(["GMAIL_GET_DRAFT", "GMAIL_UPDATE_DRAFT", "GMAIL_GET_DRAFT"]);
    expect(gmail.to).toEqual(["ana@example.com", "dan@example.com"]);
    expect(gmail.subject).toBe("Launch");
    expect(threads.get("tA")![0]!.emailDraft?.to).toEqual(["ana@example.com", "dan@example.com"]);
  });

  it("saves when Gmail holds the same draft written its own way: names on addresses, other order, rewrapped lines", async () => {
    const { connection, ran } = relayed(() => ({ successful: true, data: { id: "r-123" } }), undefined,
      { ...shownDraft, to: ["Ben <BEN@example.com>", "\"Ana, A.\" <ana@example.com>"], body: "Hi both,\r\nready.\r\n" });
    const { row, route } = setup({}, connection);
    const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
    await route(context);
    expect(sent.status).toBe(200);
    expect(ran.map((one) => one.slug)).toEqual(["GMAIL_GET_DRAFT", "GMAIL_UPDATE_DRAFT"]);
  });

  it("saves nothing when Gmail's answer doesn't say what the draft holds", async () => {
    const full = heldAnswer(shownDraft) as { data: { message: Record<string, unknown> } };
    const { payload: _headers, ...noHeaders } = full.data.message;
    const { messageText: _text, ...noText } = full.data.message;
    for (const data of [{ id: "r-123" }, { id: "r-123", message: noHeaders }, { id: "r-123", message: noText }]) {
      const gmail = relayed(() => ({ successful: true, data: { id: "r-123" } }));
      const connection: DraftConnection = { ok: true, relay: async (payload, session, signal, beforeSend) => {
        const frame = payload as { id?: unknown; method: string };
        if (frame.method !== "tools/call") return (gmail.connection as Relay).relay(payload, session, signal, beforeSend);
        beforeSend?.();
        gmail.ran.push({ slug: "GMAIL_GET_DRAFT", arguments: {} });
        return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(answer("GMAIL_GET_DRAFT", { successful: true, data }, frame.id))) };
      } };
      const { store, row, route } = setup({}, connection);
      const { context, sent } = request({ threadId: "t1", messageId: row.id, ...save });
      await route(context);
      expect(sent.status).toBe(502);
      expect(errorKey(sent)).toBe("serverError.emailDraft.unreadable");
      expect(gmail.ran.map((one) => one.slug)).toEqual(["GMAIL_GET_DRAFT"]);
      expect(store.rows[0]!.emailDraft).toMatchObject({ ...shownDraft, draftId: "r-123" });
    }
  });
});
