import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { EmailAccount } from "../email/store.ts";
import type { EmailCodeAsk } from "../login-fill.ts";
import { startFakeConnectedApps, type FakeConnectedApps } from "../testing/fake-connected-apps.ts";
import { createLoginMailCodes, MAIL_CARD_FILE, type LoginMailCodesDeps } from "./login-mail-codes.ts";

const NOW = 1_700_000_000_000;
const CODE = "483920";
const turn = { botId: "b1", threadId: "t1", generation: "g1" };
const bot = { id: "b1", name: "Ada" };

let fake: FakeConnectedApps | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

function ask(over: Partial<EmailCodeAsk> = {}): EmailCodeAsk {
  let clock = NOW;
  return { site: "acme.test", boxes: 1, askedAt: NOW, via: "email", now: () => clock, sleep: async (ms) => { clock += ms; }, ...over };
}

const gmailMail = (over: Record<string, unknown> = {}) => ({
  messageId: "m1", threadId: "t", messageTimestamp: new Date(NOW + 2_000).toISOString(), sender: "Acme <no-reply@acme.test>", subject: "Your code",
  payload: { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: Buffer.from(`Your verification code is ${CODE}`).toString("base64url") } }] },
  ...over,
});

async function setup(over: Partial<LoginMailCodesDeps> = {}) {
  fake = await startFakeConnectedApps();
  const relayed: string[] = [];
  const connectCard = vi.fn<LoginMailCodesDeps["connectCard"]>(async () => ({ status: 200, body: { messageIds: ["c1"] } }));
  const deps: LoginMailCodesDeps = {
    dataDir: mkdtempSync(join(tmpdir(), "omb-mail-codes-")),
    cfg: () => ({}) as AppConfig,
    composio: {
      configured: () => true,
      connectedServices: async () => Object.fromEntries(Object.entries(fake!.connected).map(([slug, connected]) => [slug, { connected, accounts: [] }])) as never,
      relayMcp: async (_cfg, payload, session, _before, _signal, access) => {
        if (access) relayed.push(access.token);
        const response = await fetch(`${fake!.url}/v1/mcp`, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) } });
        const transportSessionId = response.headers.get("mcp-session-id") ?? undefined;
        return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), contentType: "application/json", ...(transportSessionId ? { transportSessionId } : {}) };
      },
    },
    personApps: () => [],
    turnPerson: () => null,
    appsAccess: () => null,
    appAllowed: () => true,
    imapAccounts: () => [],
    imapGuard: async ({ host }) => ({ host }),
    unattended: () => false,
    connectCard,
    ...over,
  };
  return { codes: createLoginMailCodes(deps), deps, relayed, connectCard, fake: fake! };
}

describe("emailed codes through a connected Gmail", () => {
  it("reads a full message only for a matching sender, and returns the code", async () => {
    const { codes, fake } = await setup();
    fake.emails = [gmailMail()];
    expect(await codes.find(bot, turn, ask(), () => true)).toMatchObject({ kind: "code", code: CODE });
    expect(fake.calls.find((call) => call.tool === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")?.arguments).toMatchObject({ format: "full" });
  });

  it("does not open the body of a message from another site", async () => {
    const { codes, fake } = await setup();
    fake.emails = [gmailMail({ sender: "no-reply@evil.test" })];
    expect(await codes.find(bot, turn, ask(), () => true)).toEqual({ kind: "miss", why: "wrong-sender" });
    expect(fake.calls.some((call) => call.tool === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")).toBe(false);
  });

  it("will not hand the same code out twice", async () => {
    const { codes, fake } = await setup();
    fake.emails = [gmailMail()];
    const first = await codes.find(bot, turn, ask(), () => true);
    if (first.kind !== "code") throw new Error("expected a code");
    first.typed();
    expect(await codes.find(bot, turn, ask({ askedAt: NOW }), () => true)).toEqual({ kind: "miss", why: "used" });
  });

  it("treats a Gmail answer of another shape as unreadable, never as a code", async () => {
    const { codes, fake } = await setup();
    fake.emails = [gmailMail({ payload: undefined })];
    expect(await codes.find(bot, turn, ask(), () => true)).toEqual({ kind: "miss", why: "unreadable" });
  });
});

describe("emailed codes through a connected Outlook", () => {
  it("reads the list and the message", async () => {
    const { codes, fake } = await setup();
    fake.connected = { gmail: false, outlook: true };
    fake.outlook = [{ id: "o1", subject: "Code", receivedDateTime: new Date(NOW + 2_000).toISOString(), from: { emailAddress: { name: "Acme", address: "no-reply@acme.test" } }, body: { contentType: "html", content: `<p>Your code is <b>${CODE}</b></p>` } }];
    expect(await codes.find(bot, turn, ask(), () => true)).toMatchObject({ kind: "code", code: CODE });
    expect(fake.calls.find((call) => call.tool === "OUTLOOK_LIST_MESSAGES")?.arguments).toMatchObject({ user_id: "me", folder: "inbox", top: 20 });
    expect(fake.calls.find((call) => call.tool === "OUTLOOK_GET_MESSAGE")?.arguments).toMatchObject({ user_id: "me", message_id: "o1" });
  });
});

describe("emailed codes through an IMAP mailbox", () => {
  it("lists by arrival and reads only the matching message", async () => {
    const account = { address: "ada@acme.test" } as EmailAccount;
    const readMessage = vi.fn(async () => ({ text: `Your code is ${CODE}` }) as never);
    const { codes } = await setup({
      composio: { configured: () => false, connectedServices: async () => ({}), relayMcp: async () => { throw new Error("no relay"); } },
      imapAccounts: () => [account],
      run: { recentInbox: async () => [{ uid: 7, at: NOW + 2_000, from: "no-reply@acme.test", subject: "Code" }, { uid: 8, at: NOW + 2_000, from: "x@evil.test", subject: "Hello" }], readMessage },
    });
    expect(await codes.find(bot, turn, ask(), () => true)).toMatchObject({ kind: "code", code: CODE });
    expect(readMessage).toHaveBeenCalledOnce();
    expect(readMessage.mock.calls[0]![2 as never]).toMatchObject({ uid: 7, mailbox: "INBOX" });
  });
});

describe("no mailbox connected", () => {
  it("answers no-mailbox, and shows the Gmail card once ever for this person", async () => {
    const { codes, fake, deps, connectCard } = await setup();
    fake.connected = { gmail: false };
    expect(await codes.find(bot, turn, ask(), () => true)).toEqual({ kind: "no-mailbox" });
    expect(await codes.offerConnect(bot, turn)).toEqual({ shown: true });
    expect(connectCard).toHaveBeenCalledWith(turn, expect.objectContaining({ items: ["gmail"], botId: "b1", threadId: "t1" }));
    expect(await codes.offerConnect(bot, turn)).toEqual({ shown: false });
    expect(connectCard).toHaveBeenCalledOnce();
    expect(existsSync(join(deps.dataDir, MAIL_CARD_FILE))).toBe(true);
    expect(readFileSync(join(deps.dataDir, MAIL_CARD_FILE), "utf8")).toContain("home");
    const after = createLoginMailCodes({ ...deps });
    expect(await after.offerConnect(bot, turn)).toEqual({ shown: false });
    expect(connectCard).toHaveBeenCalledOnce();
  });

  it("does not ask when the page did not say the code was emailed", async () => {
    const { codes, fake } = await setup();
    fake.connected = { gmail: false };
    expect(await codes.find(bot, turn, ask({ via: "unknown" }), () => true)).toEqual({ kind: "skip" });
  });

  it("offers no card to a routine, where nobody is there to press it", async () => {
    const { codes, connectCard } = await setup({ unattended: () => true });
    expect(await codes.offerConnect(bot, turn)).toEqual({ shown: false });
    expect(connectCard).not.toHaveBeenCalled();
  });

  it("does not claim none is connected when the lookup failed", async () => {
    const { codes, deps } = await setup();
    deps.composio.connectedServices = async () => { throw new Error("broker down"); };
    expect(await codes.find(bot, turn, ask(), () => true)).toEqual({ kind: "miss", why: "unreadable" });
  });
});

describe("whose mailbox", () => {
  it("never reads a person's own Gmail on a Team Cloud turn that does not act for them", async () => {
    const { codes, fake, relayed } = await setup({ personApps: () => ["gmail"], turnPerson: () => null, appsAccess: () => ({ url: "http://x", token: "ada-token" }) });
    fake.connected = { gmail: true };
    fake.emails = [gmailMail()];
    const answer = await codes.find(bot, turn, ask({ via: "unknown" }), () => true);
    expect(answer).toEqual({ kind: "skip" });
    expect(fake.calls).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it("reads it as that person's own connection when the turn acts for them", async () => {
    const access = { url: "http://x", token: "ada-token" };
    const connected = vi.fn(async () => ({ gmail: { connected: true, accounts: [] } }) as never);
    const { codes, fake, relayed, deps } = await setup({ personApps: () => ["gmail"], turnPerson: () => "p_ada", appsAccess: () => access });
    deps.composio.connectedServices = connected;
    fake.emails = [gmailMail()];
    expect(await codes.find(bot, turn, ask(), () => true)).toMatchObject({ kind: "code", code: CODE });
    expect(connected).toHaveBeenCalledWith(expect.anything(), access);
    expect(new Set(relayed)).toEqual(new Set(["ada-token"]));
  });

  it("passes on the team's plain line for a person's own Gmail, instead of a card", async () => {
    const line = 'Reply with this: "Connect your Gmail here: https://x"';
    const { codes } = await setup({ personApps: () => ["gmail"], turnPerson: () => "p_ada", connectCard: async () => ({ status: 409, body: { error: line } }) });
    expect(await codes.offerConnect(bot, turn)).toEqual({ shown: false, line });
  });

  it("respects a bot's own switches", async () => {
    const { codes, fake } = await setup();
    fake.emails = [gmailMail()];
    expect(await codes.find({ ...bot, composio: false }, turn, ask({ via: "unknown" }), () => true)).toEqual({ kind: "skip" });
    expect(await codes.find({ ...bot, connectorTools: {} }, turn, ask({ via: "unknown" }), () => true)).toEqual({ kind: "skip" });
    expect(fake.calls).toEqual([]);
  });
});
