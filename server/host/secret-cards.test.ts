import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import type { BotRecord, Message } from "../store.ts";
import { EMAIL_CANT_SEND_TEXT } from "../email/instructions.ts";
import { createSecretCards } from "./secret-cards.ts";
import { CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";
import { redactBotAuthored } from "../message-redaction.ts";
import { redactSecretsInText } from "../redact.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(language?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-secret-cards-"));
  dirs.push(dataDir);
  const lines: Message[] = [];
  let ids = 0;
  const store = {
    activePath: () => lines,
    messagesFor: () => lines,
    appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message;
      lines.push(full);
      return full;
    },
    patchMessage: () => null,
    botByThread: () => null,
    groupByThread: () => undefined,
    onChange: () => () => {},
  };
  const bot = { id: "ledger", name: "Ledger" } as BotRecord;
  const cards = createSecretCards({
    store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
    phoneSecrets: { provide: async () => {}, open: () => {} } as never, phoneSecretSubmissions: {} as never,
    connectorThread: () => ({ bot, group: undefined }), answerCardNode: () => true, followCard: () => {}, dataDir, providerKeysRefused: false,
    layerFolder: () => dataDir, turnVm: () => undefined, ...(language ? { threadLanguage: () => language } : {}),
  });
  return { cards, lines, bot };
}

describe("the card a bot asks for a key or secret with", () => {
  it.each([
    ["greenferenceApiKey", "secretCard.greenference.description"],
    ["geminiTtsKey", "secretCard.geminiTts.description"],
  ] as const)("keeps the fallback and structured description for %s", (credentialId, baseCode) => {
    const { cards, lines, bot } = fixture();
    const reason = "For the requested report.";
    expect(cards.requestCredential(bot, "ledger-main", { credentialId, reason: `  ${reason}  ` }).status).toBe(201);
    expect(lines[0]!.secret).toMatchObject({
      description: `${CREDENTIAL_TARGETS[credentialId].description} ${reason} Ledger can use it but never read it back.`,
      descriptionParts: { baseCode, reason, bot: "Ledger" },
    });
  });

  it.each(["greenferenceApiKey", "geminiTtsKey"] as const)("scrubs the structured description data for %s", (credentialId) => {
    const { cards, lines, bot } = fixture();
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const reason = `Use ${key} for this report.`;
    bot.name = `Ledger ${key}`;
    cards.requestCredential(bot, "ledger-main", { credentialId, reason });
    const scrubbed = redactBotAuthored(lines[0]!);
    expect(JSON.stringify(scrubbed)).not.toContain(key);
    expect(scrubbed.secret?.descriptionParts).toMatchObject({
      reason: redactSecretsInText(reason),
      bot: redactSecretsInText(bot.name),
    });
    expect(lines[0]!.secret!.descriptionParts!.reason).toBe(reason);
  });

  it("asks in the language of the conversation's person", () => {
    const { cards, lines, bot } = fixture("de");
    expect(cards.requestCredential(bot, "ledger-main", { credentialId: "xaiApiKey" }).status).toBe(201);
    expect(cards.requestCredential(bot, "ledger-main", { label: "Stripe-Testschlüssel", reason: "Für Testzahlungen.", delivery: "file" }).status).toBe(201);
    expect(lines.map((line) => line.text)).toEqual([
      "Gib xAI API key sicher in OpenMausBot auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
      "Gib Stripe-Testschlüssel sicher in OpenMausBot auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
    ]);
    expect(lines[0]!.secret!.description).toBe("Used by the built-in Grok provider. Ledger kann es verwenden, aber nie auslesen.");
    expect(lines[1]!.secret!.description)
      .toBe("Für Testzahlungen. Die Befehle von Ledger können es 24 Stunden lang aus einer privaten Datei lesen; es wird nie in den Chat übernommen.");
  });

  it("asks in English where no language is known", () => {
    const { cards, lines, bot } = fixture();
    cards.requestCredential(bot, "ledger-main", { label: "Notion token", reason: "For Notion's MCP server.", delivery: "ref" });
    expect(lines[0]!.text).toBe("Securely provide the Notion token from OpenMausBot on your phone or computer. It is never added to chat.");
    expect(lines[0]!.secret!.description).toBe("For Notion's MCP server. Ledger gets a one-use reference for OpenMausBot's own tools and never sees it.");
  });
});

describe("the mailbox card", () => {
  const PASSWORD = "fake-mailbox-password";
  const ACCOUNT = { address: "me@shop.example", imapHost: "imap.shop.example", smtpHost: "smtp.shop.example", connectedAt: "2026-11-04T00:00:00.000Z" };
  function mail(options: { refusal?: string; connected?: boolean; sendingProblem?: string; profile?: string; connect?: (request: Record<string, unknown>, reading?: (host: string) => void) => unknown;
    account?: Record<string, unknown>; checkOutgoing?: (fields: Record<string, unknown>) => unknown } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-secret-cards-"));
    dirs.push(dataDir);
    const lines: Message[] = [];
    let ids = 0;
    const store = {
      activePath: () => lines,
      messagesFor: () => lines,
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message; lines.push(full); return full; },
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id)!; Object.assign(line, patch); return line; },
      botByThread: () => null, groupByThread: () => undefined, onChange: () => () => {},
    };
    const connects: Array<Record<string, unknown>> = [];
    const checks: Array<Record<string, unknown>> = [];
    const state = { sendingProblem: options.sendingProblem };
    const resumed: string[] = [];
    const bot = { id: "ledger", name: "Ledger" } as BotRecord;
    const cards = createSecretCards({
      store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
      phoneSecrets: { provide: async () => {}, open: async () => PASSWORD } as never, phoneSecretSubmissions: { has: () => false, run: async (_card: unknown, _op: unknown, work: () => Promise<void>) => work() } as never,
      connectorThread: () => ({ bot, group: undefined }), answerCardNode: (_thread, _id, text) => { resumed.push(text); return true; }, followCard: () => {}, dataDir, providerKeysRefused: false,
      layerFolder: () => dataDir, turnVm: () => undefined,
      email: {
        connect: async (request, reading) => { connects.push(request as never); return (options.connect?.(request as never, reading) ?? { ok: true, account: ACCOUNT, inbox: { messages: 3 }, sending: { ok: true } }) as never; },
        refusal: () => options.refusal, connected: () => options.connected === true, sendingProblem: () => state.sendingProblem, profileAddress: () => options.profile,
        account: () => options.account as never,
        checkOutgoing: async (_address, fields) => {
          checks.push(fields as never);
          const answer = (options.checkOutgoing?.(fields as never) ?? { ok: true, account: ACCOUNT }) as { ok: boolean };
          if (answer.ok) state.sendingProblem = undefined;
          return answer as never;
        },
      },
    });
    return { cards, lines, bot, connects, checks, resumed };
  }
  const ask = (fixture: ReturnType<typeof mail>, body: Record<string, unknown> = {}) => fixture.cards.requestCredential(fixture.bot, "t1", { credentialId: "email", ...body });
  const card = (fixture: ReturnType<typeof mail>) => fixture.lines.findLast((line) => line.kind === "secret")!;

  it("is one card, which a phone shows as any secret, naming the address the bot knows", () => {
    const fixture = mail();
    expect(ask(fixture, { address: "me@shop.example", reason: "To read today's invoices." })).toMatchObject({ status: 201, body: { delivery: "email" } });
    expect(card(fixture).secret).toMatchObject({ target: "customSecret", delivery: "email", address: "me@shop.example", label: "Connect your mailbox", placeholder: "Mailbox password", helpUrl: "" });
    expect(card(fixture).secret!.description).toContain("To read today's invoices.");
    expect(card(fixture).secret!.description).toContain("Ledger never sees the password.");
  });

  it("names the person's own address when the bot knows none, and none at all when it can't", () => {
    const known = mail({ profile: "owner@shop.example" });
    ask(known);
    expect(card(known).secret!.address).toBe("owner@shop.example");
    const unknown = mail();
    ask(unknown, { address: "not an address" });
    expect(card(unknown).secret!.address).toBeUndefined();
  });

  it("doesn't ask again for a mailbox that works, and a newer card replaces an older one", () => {
    const working = mail({ connected: true });
    expect(ask(working, { address: "me@shop.example" })).toEqual({ status: 200, body: { alreadyConfigured: true, label: "me@shop.example", text: "me@shop.example is already connected. Use the email tools." } });
    expect(working.lines).toEqual([]);
    const fixture = mail();
    ask(fixture);
    const first = card(fixture);
    ask(fixture);
    expect(first.secret!.superseded).toBe(true);
  });

  it("is refused where a place can't have mailboxes, in its words", () => {
    const fixture = mail({ refusal: "Email isn't on a Team Cloud yet." });
    expect(ask(fixture)).toEqual({ status: 403, body: { error: "Email isn't on a Team Cloud yet." } });
    expect(fixture.lines).toEqual([]);
  });

  it("a refused password leaves the card open with why; the right one connects and resumes the bot without it", async () => {
    let good = false;
    const fixture = mail({ connect: () => (good ? undefined : { ok: false, error: "The mail server did not accept this address and password." }) });
    ask(fixture, { address: "me@shop.example" });
    const { id } = card(fixture);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD })).toEqual({ status: 400, body: { error: "The mail server did not accept this address and password." } });
    expect(card(fixture).secret).not.toMatchObject({ provided: true });
    expect(fixture.resumed).toEqual([]);
    good = true;
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD })).toMatchObject({ status: 200, body: { provided: true, resumed: true } });
    expect(fixture.connects.at(-1)).toEqual({ address: "me@shop.example", password: PASSWORD });
    expect(card(fixture).secret).toMatchObject({ provided: true, resumed: true, address: "me@shop.example" });
    expect(fixture.resumed).toHaveLength(1);
    expect(fixture.resumed[0]).toContain("me@shop.example");
    expect(JSON.stringify([fixture.lines, fixture.resumed])).not.toContain(PASSWORD);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD }), "only once").toMatchObject({ status: 409 });
  });

  it("the address and the server the person types win, and asking for a server is passed on", async () => {
    const fixture = mail({ connect: (request) => (request.imapHost ? undefined : { ok: false, needsServer: true, error: "We couldn't find your mail server." }) });
    ask(fixture, { address: "wrong@shop.example" });
    const { id } = card(fixture);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example" })).toEqual({ status: 400, body: { error: "We couldn't find your mail server.", needsServer: true } });
    await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example", imapHost: "post.example", imapPort: 993, smtpHost: "out.example", smtpPort: 587, username: "m1", other: "ignored" });
    expect(fixture.connects.at(-1)).toEqual({ address: "me@shop.example", password: PASSWORD, imapHost: "post.example", imapPort: 993, smtpHost: "out.example", smtpPort: 587, username: "m1" });
  });

  it("needs an address and a password, and goes no further on a dismissed card", async () => {
    const fixture = mail();
    ask(fixture);
    const { id } = card(fixture);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD })).toMatchObject({ status: 400 });
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: "", address: "me@shop.example" })).toMatchObject({ status: 400 });
    expect(fixture.connects).toEqual([]);
    card(fixture).secret!.dismissed = true;
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example" })).toMatchObject({ status: 409 });
    expect(fixture.connects).toEqual([]);
  });

  it("a send that can't go tells the bot why, to open the outgoing-server card, and not to retry or ask in chat", () => {
    const text = EMAIL_CANT_SEND_TEXT("me@shop.example", "The outgoing server smtp.shop.example:587 refused the password.");
    expect(text).toContain("refused the password");
    expect(text).toContain("request_credential with credential_id email and address me@shop.example");
    expect(text).toContain("Don't retry");
    expect(text).toContain("never ask for the password in chat");
    expect(text).not.toMatch(/try again/iu);
  });

  it("while connecting the card shows the incoming server that took the password, and a failure takes it away", async () => {
    const shown: Array<string | undefined> = [];
    let fail = true;
    const fixture = mail({ connect: (_request, reading) => {
      reading?.("imap.shop.example");
      shown.push(card(fixture).secret!.emailReading);
      return fail ? { ok: false, error: "nope" } : undefined;
    } });
    ask(fixture, { address: "me@shop.example" });
    const { id } = card(fixture);
    await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD });
    expect(shown).toEqual(["imap.shop.example"]);
    expect(card(fixture).secret!.emailReading).toBeUndefined();
    fail = false;
    await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD });
    expect(card(fixture).secret).toMatchObject({ provided: true, emailReading: "imap.shop.example" });
  });

  it("Gmail and Outlook's way to sign in reaches the card, and only reading connected tells the bot sending waits for the person", async () => {
    const signIn = { provider: "Microsoft", app: "outlook" };
    const refused = mail({ connect: () => ({ ok: false, error: "Microsoft doesn't let mail programs in with a password.", signIn }) });
    ask(refused, { address: "me@outlook.com" });
    expect(await refused.cards.saveEmailSecret("ledger", "t1", card(refused).id, { value: PASSWORD })).toEqual({ status: 400, body: { error: "Microsoft doesn't let mail programs in with a password.", signIn } });
    const problem = "smtp.shop.example didn't answer on 465 or 587.";
    const readOnly = mail({ sendingProblem: problem, connect: () => ({ ok: true, account: { ...ACCOUNT, smtpHost: undefined, sendingProblem: problem }, inbox: { messages: 3 }, sending: { ok: false, problem } }) });
    ask(readOnly, { address: "me@shop.example" });
    expect(await readOnly.cards.saveEmailSecret("ledger", "t1", card(readOnly).id, { value: PASSWORD })).toMatchObject({ status: 200, body: { provided: true, sendingProblem: problem } });
    expect(readOnly.resumed[0]).toContain(problem);
    expect(readOnly.resumed[0]).not.toContain("EMAIL_SEND_MESSAGE");
  });

  it("the bot hears that it may go on, or that the person declined, never a value", () => {
    const fixture = mail();
    ask(fixture, { address: "me@shop.example" });
    const secret = card(fixture).secret!;
    expect(fixture.cards.updateText(card(fixture).id, secret, "provided")).toContain("EMAIL_LIST_MESSAGES");
    expect(fixture.cards.updateText(card(fixture).id, secret, "dismissed")).toContain("chose not to connect a mailbox");
  });
  describe("a mailbox that reads but can't send", () => {
    const problem = "smtp.shop.example didn't answer on 465 or 587.";
    const readOnly = { ...ACCOUNT, smtpHost: undefined, smtpTried: { smtpHost: "smtp.shop.example", smtpPort: 587 }, smtpUsername: "me", sendingProblem: problem };

    it("gets a card for its outgoing server, started from the server it tried, never a password", () => {
      const fixture = mail({ connected: true, sendingProblem: problem, account: readOnly });
      expect(ask(fixture, { address: "me@shop.example", reason: "To send the invoice." })).toMatchObject({ status: 201, body: { delivery: "email", outgoing: true } });
      const first = card(fixture);
      const secret = first.secret!;
      expect(secret).toMatchObject({ target: "customSecret", delivery: "email", address: "me@shop.example", label: "Outgoing server for me@shop.example", placeholder: "Password for sending" });
      expect(secret.emailOutgoing).toEqual({ smtpHost: "smtp.shop.example", smtpPort: 587, smtpUsername: "me" });
      expect(secret.description).toContain(problem);
      expect(secret.description).toContain("To send the invoice.");
      expect(secret.description).toContain("Ledger never sees the password.");
      ask(fixture, { address: "me@shop.example" });
      expect(first.secret!.superseded, "a newer one replaces it").toBe(true);
    });

    it("checks sending at the server typed, keeps the card open with why, and resumes the bot once it sends", async () => {
      const answers = [
        { ok: false, error: "smtp.easy.example didn't answer on 587.", account: { ...readOnly, smtpTried: { smtpHost: "smtp.easy.example", smtpPort: 587 } } },
        { ok: true, account: { ...ACCOUNT, smtpHost: "smtp.easy.example", smtpPort: 587, smtpSecurity: "starttls" } },
      ];
      const fixture = mail({ connected: true, sendingProblem: problem, account: readOnly, checkOutgoing: () => answers.shift() });
      ask(fixture, { address: "me@shop.example" });
      const id = card(fixture).id;
      const typed = { smtpHost: "smtp.easy.example", smtpPort: 587, smtpSecurity: "starttls", smtpPassword: PASSWORD, address: "other@shop.example", imapHost: "imap.other.example", value: "not this" };
      expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, typed)).toEqual({ status: 400, body: { error: "smtp.easy.example didn't answer on 587." } });
      expect(fixture.checks[0], "only the outgoing fields go").toEqual({ smtpHost: "smtp.easy.example", smtpPort: 587, smtpSecurity: "starttls", smtpPassword: PASSWORD });
      expect(card(fixture).secret).toMatchObject({ emailOutgoing: { smtpHost: "smtp.easy.example", smtpPort: 587 } });
      expect(card(fixture).secret!.provided).toBeFalsy();
      expect(fixture.connects, "reading is never signed in to again").toEqual([]);
      expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, typed)).toMatchObject({ status: 200, body: { provided: true, resumed: true } });
      expect(card(fixture).secret!.emailOutgoing).toEqual({ smtpHost: "smtp.easy.example", smtpPort: 587, smtpSecurity: "starttls" });
      expect(fixture.resumed[0]).toContain("sending from me@shop.example works now");
      expect(fixture.resumed[0]).toContain("EMAIL_SEND_MESSAGE");
      expect(JSON.stringify(fixture.resumed) + JSON.stringify(card(fixture))).not.toContain(PASSWORD);
      expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, typed), "only once").toMatchObject({ status: 409 });
    });

    it("the bot hears that the person declined, and still never a value", () => {
      const fixture = mail({ connected: true, sendingProblem: problem, account: readOnly });
      ask(fixture, { address: "me@shop.example" });
      const secret = card(fixture).secret!;
      expect(fixture.cards.updateText(card(fixture).id, secret, "dismissed")).toContain("chose not to set up sending for me@shop.example");
      expect(fixture.cards.updateText(card(fixture).id, secret, "provided")).toContain(problem);
    });
  });
});
