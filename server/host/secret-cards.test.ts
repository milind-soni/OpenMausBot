import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import type { BotRecord, Message } from "../store.ts";
import { EMAIL_CANT_SEND_TEXT } from "../email/instructions.ts";
import { createSecretCards, type SecretCardsDeps } from "./secret-cards.ts";
import { CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";
import { redactBotAuthored } from "../message-redaction.ts";
import { redactSecretsInText } from "../redact.ts";
import { TEAM_READER, VaultStore } from "../vault-store.ts";
import { BotLogins } from "../bot-logins.ts";
import { OnePasswordLogins, sdkOnePasswordClient } from "../onepassword.ts";
import { fakeOnePasswordSdk } from "../testing/fake-onepassword.ts";
import type { LoginBots } from "../../shared/logins.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** `privateTo`: a Team Cloud's private chats, by conversation, and whose each is; any other conversation is the team's. */
function fixture(language?: string, linked?: (vaultStore: VaultStore) => SecretCardsDeps["botLogins"], privateTo: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-secret-cards-"));
  dirs.push(dataDir);
  const lines: Message[] = [];
  let ids = 0;
  const store = {
    activePath: () => [...lines],
    messagesFor: () => lines,
    appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message;
      lines.push(full);
      return full;
    },
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => Object.assign(lines.find((one) => one.id === id)!, patch),
    botByThread: () => null,
    groupByThread: () => undefined,
    onChange: () => () => {},
  };
  const bot = { id: "ledger", name: "Ledger" } as BotRecord;
  const vaultStore = new VaultStore({ dataDir });
  const resumed: string[] = [];
  const cards = createSecretCards({
    store: store as never, cfg: {} as never, vaultStore, vaultReader: (threadId) => ({ person: privateTo[threadId] ?? null, team: true }),
    botLogins: linked?.(vaultStore) ?? { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }), linkedSecret: async () => null },
    phoneSecrets: { provide: async () => {}, open: () => {} } as never, phoneSecretSubmissions: { has: () => false } as never,
    connectorThread: () => ({ bot, group: undefined }), answerCardNode: (_thread, _id, text) => { resumed.push(text); return true; }, followCard: () => {}, dataDir, providerKeysRefused: false,
    layerFolder: () => dataDir, turnVm: () => undefined, ...(language ? { threadLanguage: () => language } : {}),
  });
  return { cards, lines, bot, vaultStore, resumed, dataDir };
}

describe("the card a bot asks for a key or secret with", () => {
  it.each([
    ["greenferenceApiKey", "secretCard.greenference.description"],
    ["llmtrApiKey", "secretCard.llmtr.description"],
    ["modelgoApiKey", "secretCard.modelgo.description"],
    ["geminiTtsKey", "secretCard.geminiTts.description"],
  ] as const)("keeps the fallback and structured description for %s", async (credentialId, baseCode) => {
    const { cards, lines, bot } = fixture();
    const reason = "For the requested report.";
    expect((await cards.requestCredential(bot, "ledger-main", { credentialId, reason: `  ${reason}  ` })).status).toBe(201);
    expect(lines[0]!.secret).toMatchObject({
      description: `${CREDENTIAL_TARGETS[credentialId].description} ${reason} Ledger can use it but never read it back.`,
      descriptionParts: { baseCode, reason, bot: "Ledger" },
    });
  });

  it.each(["greenferenceApiKey", "llmtrApiKey", "geminiTtsKey"] as const)("scrubs the structured description data for %s", async (credentialId) => {
    const { cards, lines, bot } = fixture();
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const reason = `Use ${key} for this report.`;
    bot.name = `Ledger ${key}`;
    await cards.requestCredential(bot, "ledger-main", { credentialId, reason });
    const scrubbed = redactBotAuthored(lines[0]!);
    expect(JSON.stringify(scrubbed)).not.toContain(key);
    expect(scrubbed.secret?.descriptionParts).toMatchObject({
      reason: redactSecretsInText(reason),
      bot: redactSecretsInText(bot.name),
    });
    expect(lines[0]!.secret!.descriptionParts!.reason).toBe(reason);
  });

  it("asks in the language of the conversation's person", async () => {
    const { cards, lines, bot } = fixture("de");
    expect((await cards.requestCredential(bot, "ledger-main", { credentialId: "xaiApiKey" })).status).toBe(201);
    expect((await cards.requestCredential(bot, "ledger-main", { label: "Stripe-Testschlüssel", reason: "Für Testzahlungen.", delivery: "file" })).status).toBe(201);
    expect(lines.map((line) => line.text)).toEqual([
      "Gib xAI API key sicher in OpenMausBot auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
      "Gib Stripe-Testschlüssel sicher in OpenMausBot auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
    ]);
    expect(lines[0]!.secret!.description).toBe("Used by the built-in Grok provider. Ledger kann es verwenden, aber nie auslesen.");
    expect(lines[1]!.secret!.description)
      .toBe("Für Testzahlungen. Die Befehle von Ledger können es 24 Stunden lang aus einer privaten Datei lesen; es wird nie in den Chat übernommen. OpenMausBot bewahrt es sicher auf, damit Ledger es wieder nutzen kann, ohne dich erneut zu fragen.");
  });

  it("asks in English where no language is known", async () => {
    const { cards, lines, bot } = fixture();
    await cards.requestCredential(bot, "ledger-main", { label: "Notion token", reason: "For Notion's MCP server.", delivery: "ref" });
    expect(lines[0]!.text).toBe("Securely provide the Notion token from OpenMausBot on your phone or computer. It is never added to chat.");
    expect(lines[0]!.secret!.description).toBe("For Notion's MCP server. Ledger gets a one-use reference for OpenMausBot's own tools and never sees it. OpenMausBot keeps it safely, so Ledger can use it again without asking you.");
  });
});

describe("a secret a card saves to the Vault", () => {
  const KEY = "sk_test_fake-card-vault-1";
  const ask = (one: ReturnType<typeof fixture>, threadId: string, extra: Record<string, unknown> = {}) =>
    one.cards.requestCredential(one.bot, threadId, { label: "Stripe secret key", reason: "For test charges.", delivery: "ref", ...extra });
  const refIn = (text: unknown) => /secret-ref:[0-9a-f]{32}/u.exec(String(text))?.[0];

  it("is kept for the asking bot, and its next ask, in any conversation and after any ref is spent, gets a fresh one with no card", async () => {
    const one = fixture();
    const card = await ask(one, "t1");
    expect(card.status).toBe(201);
    expect(one.cards.saveCustomSecret("ledger", "t1", String(card.body.messageId), `  ${KEY} `).status).toBe(200);
    expect(one.vaultStore.listSecrets(TEAM_READER)).toMatchObject([{ name: "Stripe secret key", source: "card", bots: ["ledger"], refOnly: true }]);
    const fromCard = refIn(one.resumed[0]);
    expect(fromCard).toBeDefined();
    const spent = one.cards.redeemMcpServer({ env: { STRIPE_SECRET_KEY: fromCard } }, "ledger", "t1", "stripe");
    if (spent.ok) spent.commit();
    const again = await ask(one, "t2", { label: "stripe-secret-key" });
    expect(again.status).toBe(200);
    const fresh = refIn(again.body.text);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(fromCard);
    expect(one.lines.filter((line) => line.kind === "secret")).toHaveLength(1);
    const used = one.cards.redeemMcpServer({ env: { STRIPE_SECRET_KEY: fresh } }, "ledger", "t2", "stripe");
    const pointer = `vault:${one.vaultStore.listSecrets(TEAM_READER)[0]!.id}`;
    expect(used.ok && used.value).toEqual({ env: { STRIPE_SECRET_KEY: pointer } });
    expect(one.vaultStore.listSecrets(TEAM_READER)[0]!.lastUsedAt).toBeGreaterThan(0);
    expect(JSON.stringify([one.lines, one.resumed, again, one.vaultStore.listSecrets(TEAM_READER)])).not.toContain(KEY);
  });

  it("redeems as a vault: pointer to the saved item, kept out of config.json, and gives only that server the item once it is saved", async () => {
    const one = fixture();
    const card = await ask(one, "t1");
    one.cards.saveCustomSecret("ledger", "t1", String(card.body.messageId), KEY);
    const item = one.vaultStore.listSecrets(TEAM_READER)[0]!.id;
    const redeemed = one.cards.redeemMcpServer({ headers: { Authorization: `Bearer ${refIn(one.resumed[0])}` } }, "ledger", "t1", "stripe");
    expect(redeemed.ok && redeemed.value).toEqual({ headers: { Authorization: `Bearer vault:${item}` } });
    expect(JSON.stringify(redeemed)).not.toContain(KEY);
    expect(one.vaultStore.mcpServerKeys("stripe")).toEqual([]);
    if (redeemed.ok) redeemed.commit();
    expect(one.vaultStore.mcpServerKeys("stripe")).toEqual([item]);
  });

  it("is not another bot's, and a file for one saved for OpenMausBot's tools only needs its own card", async () => {
    const one = fixture();
    one.vaultStore.saveSecret({ name: "Stripe secret key", value: KEY, source: "card", bots: ["ledger"], refOnly: true });
    expect((await one.cards.requestCredential({ ...one.bot, id: "quill", name: "Quill" }, "t9", { label: "Stripe secret key", reason: "r", delivery: "ref" })).status).toBe(201);
    expect(await ask(one, "t1", { delivery: "file" })).toMatchObject({ status: 201, body: { savedAs: "ref" } });
  });

  it("is written to a file for the bot's commands, which the Vault remakes when asked again", async () => {
    const one = fixture();
    const item = one.vaultStore.saveSecret({ name: "Stripe secret key", value: KEY, source: "settings", bots: "all" });
    const answer = await ask(one, "t1", { delivery: "file" });
    const file = join(one.dataDir, ".openmausbot-secrets", "t1", `vault-${item.id}`);
    expect(answer).toMatchObject({ status: 200, body: { text: expect.stringContaining(`to the file ${file}`) } });
    expect(readFileSync(file, "utf8")).toBe(KEY);
    rmSync(file);
    await ask(one, "t1", { delivery: "file" });
    expect(readFileSync(file, "utf8")).toBe(KEY);
  });

  it("is asked for again when the bot says the saved one is wrong, and the new value replaces it", async () => {
    const one = fixture();
    one.vaultStore.saveSecret({ name: "Stripe secret key", value: KEY, source: "card", bots: ["ledger"], refOnly: true });
    const card = await ask(one, "t1", { replace: true });
    expect(card.status).toBe(201);
    one.cards.saveCustomSecret("ledger", "t1", String(card.body.messageId), "sk_test_fake-card-vault-2");
    expect(one.vaultStore.secretValues()).toEqual(["sk_test_fake-card-vault-2"]);
  });
});

describe("on a Team Cloud, a secret typed into a card in a member's private chat", () => {
  const ADA = "p_ada0000000000000000000", BEN = "p_ben0000000000000000000";
  const KEY = "sk_test_fake-ada-own-1";
  const team = () => fixture(undefined, undefined, { "ada-chat": ADA, "ada-routine": ADA, "ben-chat": BEN, "ben-routine": BEN });
  const ask = (one: ReturnType<typeof fixture>, threadId: string, extra: Record<string, unknown> = {}) =>
    one.cards.requestCredential(one.bot, threadId, { label: "Stripe secret key", reason: "For test charges.", delivery: "ref", ...extra });
  async function adaSaves(one: ReturnType<typeof fixture>) {
    const card = await ask(one, "ada-chat");
    expect(one.cards.saveCustomSecret("ledger", "ada-chat", String(card.body.messageId), KEY).status).toBe(200);
    return one.vaultStore.listSecrets({ person: ADA, team: false })[0]!;
  }

  it("is hers: the same bot gets it in her own chats, and nowhere else is it saved", async () => {
    const one = team();
    const own = await adaSaves(one);
    expect(own).toMatchObject({ name: "Stripe secret key", source: "card", bots: ["ledger"] });
    expect(JSON.stringify(own)).not.toContain(ADA);
    for (const threadId of ["ada-chat", "ada-routine"]) expect((await ask(one, threadId)).status, threadId).toBe(200);
    for (const threadId of ["ben-chat", "ben-routine", "ledger-main", "room-1"]) {
      const asked = await ask(one, threadId);
      expect(asked.status, `${threadId}: a card, as if nothing were saved`).toBe(201);
      expect(one.cards.savedChoices("ledger", threadId, String(asked.body.messageId)), `${threadId}: never offered by name`).toEqual([]);
      expect(await ask(one, threadId, { delivery: "file" }), `${threadId}: a file`).toMatchObject({ status: 201, body: expect.not.objectContaining({ savedAs: expect.anything() }) });
    }
    expect(one.vaultStore.listSecrets(TEAM_READER), "an admin's view").toEqual([]);
    expect(one.vaultStore.listSecrets({ person: BEN, team: false })).toEqual([]);
    expect(JSON.stringify([one.lines, one.resumed])).not.toContain(KEY);
  });

  it("is never offered by name under Use a saved one outside her own chats", async () => {
    const one = team();
    const live = await ask(one, "ada-chat", { label: "STRIPE_LIVE_KEY" });
    one.cards.saveCustomSecret("ledger", "ada-chat", String(live.body.messageId), KEY);
    const own = one.vaultStore.listSecrets({ person: ADA, team: false })[0]!;
    for (const threadId of ["ben-chat", "ledger-main", "room-1"]) {
      const card = await ask(one, threadId);
      expect(one.cards.savedChoices("ledger", threadId, String(card.body.messageId)), threadId).toEqual([]);
      expect(await one.cards.useSavedSecret("ledger", threadId, String(card.body.messageId), own.id), threadId).toMatchObject({ status: 404 });
    }
    const mine = await ask(one, "ada-chat");
    expect(one.cards.savedChoices("ledger", "ada-chat", String(mine.body.messageId))).toEqual([{ id: own.id, name: "STRIPE_LIVE_KEY" }]);
  });

  it("never goes into an MCP server, which serves the whole team, even from her own chat", async () => {
    const one = team();
    const own = await adaSaves(one);
    const ref = /secret-ref:[0-9a-f]{32}/u.exec(one.resumed[0]!)?.[0];
    const redeemed = one.cards.redeemMcpServer({ env: { STRIPE: ref } }, "ledger", "ada-chat", "stripe");
    expect(redeemed).toEqual({ ok: false, error: expect.stringContaining("Stripe secret key is the person's own") });
    expect(one.vaultStore.mcpServerKeys("stripe")).toEqual([]);
    expect(one.vaultStore.serversUsingKey(own.id)).toEqual([]);
  });

  it("leaves the team's secret of the same name as it was, which every other chat still gets", async () => {
    const one = team();
    const shared = one.vaultStore.saveSecret({ name: "Stripe secret key", value: "sk_test_fake-team", source: "settings", bots: ["ledger"] });
    const card = await ask(one, "ada-chat", { replace: true });
    one.cards.saveCustomSecret("ledger", "ada-chat", String(card.body.messageId), KEY);
    expect(one.vaultStore.secret(shared.id)?.value).toBe("sk_test_fake-team");
    expect(one.vaultStore.usableSecret("Stripe secret key", "ledger", "ref", { person: ADA, team: true })?.value).toBe(KEY);
    expect(one.vaultStore.usableSecret("Stripe secret key", "ledger", "ref", { person: BEN, team: true })?.id).toBe(shared.id);
    for (const threadId of ["ben-chat", "ledger-main", "room-1"]) expect((await ask(one, threadId)).status, threadId).toBe(200);
  });

  it("is the team's when typed in a shared chat, as before", async () => {
    const one = team();
    const card = await ask(one, "ledger-main");
    one.cards.saveCustomSecret("ledger", "ledger-main", String(card.body.messageId), KEY);
    expect(one.vaultStore.listSecrets(TEAM_READER)).toHaveLength(1);
    for (const threadId of ["ada-chat", "ben-chat", "room-1"]) expect((await ask(one, threadId)).status, threadId).toBe(200);
  });
});

describe("Use a saved one on a secret card", () => {
  const KEY = "sk_test_fake-picked-1";
  const card = async (one: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
    String((await one.cards.requestCredential(one.bot, "t1", { label: "Stripe secret key", reason: "For test charges.", delivery: "ref", ...extra })).body.messageId);

  it("offers saved secrets whose names could fit, by name only; picking one lets the bot use it and answers the card", async () => {
    const one = fixture();
    const kept = one.vaultStore.saveSecret({ name: "STRIPE_LIVE_KEY", value: KEY, source: "settings", bots: ["quill"] });
    one.vaultStore.saveSecret({ name: "GitHub token", value: "ghp_fake-unrelated", source: "settings", bots: "all" });
    const id = await card(one);
    expect(one.cards.savedChoices("ledger", "t1", id)).toEqual([{ id: kept.id, name: "STRIPE_LIVE_KEY" }]);
    expect(await one.cards.useSavedSecret("ledger", "t1", id, kept.id)).toMatchObject({ status: 200, body: { provided: true, resumed: true } });
    expect(one.vaultStore.listSecrets(TEAM_READER).find((secret) => secret.id === kept.id)).toMatchObject({ bots: ["quill", "ledger"], lastUsedAt: expect.any(Number) });
    const ref = /secret-ref:[0-9a-f]{32}/u.exec(one.resumed[0]!)?.[0];
    const used = one.cards.redeemMcpServer({ env: { STRIPE: ref } }, "ledger", "t1", "stripe");
    expect(used.ok && used.value).toEqual({ env: { STRIPE: `vault:${kept.id}` } });
    expect(one.cards.savedChoices("ledger", "t1", id)).toEqual([]);
    expect(await one.cards.useSavedSecret("ledger", "t1", id, kept.id)).toMatchObject({ status: 409 });
    expect(JSON.stringify([one.lines, one.resumed])).not.toContain(KEY);
  });

  it("never offers one given only to the app's own tools for a file, the same-named one the bot already has, or one not offered", async () => {
    const one = fixture();
    one.vaultStore.saveSecret({ name: "Stripe test key", value: "fake-ref-only", source: "card", bots: ["quill"], refOnly: true });
    expect(one.cards.savedChoices("ledger", "t1", await card(one, { delivery: "file" }))).toEqual([]);
    one.vaultStore.saveSecret({ name: "Stripe secret key", value: "fake-wrong-one", source: "settings", bots: ["ledger"] });
    const replace = await card(one, { replace: true });
    expect(one.cards.savedChoices("ledger", "t1", replace).map((choice) => choice.name)).toEqual(["Stripe test key"]);
    expect(await one.cards.useSavedSecret("ledger", "t1", replace, "not-offered")).toMatchObject({ status: 404 });
    expect(one.resumed).toEqual([]);
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
      store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }), linkedSecret: async () => null }, vaultStore: new VaultStore({ dataDir }), vaultReader: () => TEAM_READER,
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

  it("is one card, which a phone shows as any secret, naming the address the bot knows", async () => {
    const fixture = mail();
    expect(await ask(fixture, { address: "me@shop.example", reason: "To read today's invoices." })).toMatchObject({ status: 201, body: { delivery: "email" } });
    expect(card(fixture).secret).toMatchObject({ target: "customSecret", delivery: "email", address: "me@shop.example", label: "Connect your mailbox", placeholder: "Mailbox password", helpUrl: "" });
    expect(card(fixture).secret!.description).toContain("To read today's invoices.");
    expect(card(fixture).secret!.description).toContain("Ledger never sees the password.");
  });

  it("names the person's own address when the bot knows none, and none at all when it can't", async () => {
    const known = mail({ profile: "owner@shop.example" });
    await ask(known);
    expect(card(known).secret!.address).toBe("owner@shop.example");
    const unknown = mail();
    await ask(unknown, { address: "not an address" });
    expect(card(unknown).secret!.address).toBeUndefined();
  });

  it("doesn't ask again for a mailbox that works, and a newer card replaces an older one", async () => {
    const working = mail({ connected: true });
    expect(await ask(working, { address: "me@shop.example" })).toEqual({ status: 200, body: { alreadyConfigured: true, label: "me@shop.example", text: "me@shop.example is already connected. Use the email tools." } });
    expect(working.lines).toEqual([]);
    const fixture = mail();
    await ask(fixture);
    const first = card(fixture);
    await ask(fixture);
    expect(first.secret!.superseded).toBe(true);
  });

  it("is refused where a place can't have mailboxes, in its words", async () => {
    const fixture = mail({ refusal: "Email isn't on a Team Cloud yet." });
    expect(await ask(fixture)).toEqual({ status: 403, body: { error: "Email isn't on a Team Cloud yet." } });
    expect(fixture.lines).toEqual([]);
  });

  it("a refused password leaves the card open with why; the right one connects and resumes the bot without it", async () => {
    let good = false;
    const fixture = mail({ connect: () => (good ? undefined : { ok: false, error: "The mail server did not accept this address and password." }) });
    await ask(fixture, { address: "me@shop.example" });
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
    await ask(fixture, { address: "wrong@shop.example" });
    const { id } = card(fixture);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example" })).toEqual({ status: 400, body: { error: "We couldn't find your mail server.", needsServer: true } });
    await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example", imapHost: "post.example", imapPort: 993, smtpHost: "out.example", smtpPort: 587, username: "m1", other: "ignored" });
    expect(fixture.connects.at(-1)).toEqual({ address: "me@shop.example", password: PASSWORD, imapHost: "post.example", imapPort: 993, smtpHost: "out.example", smtpPort: 587, username: "m1" });
  });

  it("needs an address and a password, and goes no further on a dismissed card", async () => {
    const fixture = mail();
    await ask(fixture);
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
    await ask(fixture, { address: "me@shop.example" });
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
    await ask(refused, { address: "me@outlook.com" });
    expect(await refused.cards.saveEmailSecret("ledger", "t1", card(refused).id, { value: PASSWORD })).toEqual({ status: 400, body: { error: "Microsoft doesn't let mail programs in with a password.", signIn } });
    const problem = "smtp.shop.example didn't answer on 465 or 587.";
    const readOnly = mail({ sendingProblem: problem, connect: () => ({ ok: true, account: { ...ACCOUNT, smtpHost: undefined, sendingProblem: problem }, inbox: { messages: 3 }, sending: { ok: false, problem } }) });
    await ask(readOnly, { address: "me@shop.example" });
    expect(await readOnly.cards.saveEmailSecret("ledger", "t1", card(readOnly).id, { value: PASSWORD })).toMatchObject({ status: 200, body: { provided: true, sendingProblem: problem } });
    expect(readOnly.resumed[0]).toContain(problem);
    expect(readOnly.resumed[0]).not.toContain("EMAIL_SEND_MESSAGE");
  });

  it("the bot hears that it may go on, or that the person declined, never a value", async () => {
    const fixture = mail();
    await ask(fixture, { address: "me@shop.example" });
    const secret = card(fixture).secret!;
    expect(fixture.cards.updateText(card(fixture).id, secret, "provided")).toContain("EMAIL_LIST_MESSAGES");
    expect(fixture.cards.updateText(card(fixture).id, secret, "dismissed")).toContain("chose not to connect a mailbox");
  });
  describe("a mailbox that reads but can't send", () => {
    const problem = "smtp.shop.example didn't answer on 465 or 587.";
    const readOnly = { ...ACCOUNT, smtpHost: undefined, smtpTried: { smtpHost: "smtp.shop.example", smtpPort: 587 }, smtpUsername: "me", sendingProblem: problem };

    it("gets a card for its outgoing server, started from the server it tried, never a password", async () => {
      const fixture = mail({ connected: true, sendingProblem: problem, account: readOnly });
      expect(await ask(fixture, { address: "me@shop.example", reason: "To send the invoice." })).toMatchObject({ status: 201, body: { delivery: "email", outgoing: true } });
      const first = card(fixture);
      const secret = first.secret!;
      expect(secret).toMatchObject({ target: "customSecret", delivery: "email", address: "me@shop.example", label: "Outgoing server for me@shop.example", placeholder: "Password for sending" });
      expect(secret.emailOutgoing).toEqual({ smtpHost: "smtp.shop.example", smtpPort: 587, smtpUsername: "me" });
      expect(secret.description).toContain(problem);
      expect(secret.description).toContain("To send the invoice.");
      expect(secret.description).toContain("Ledger never sees the password.");
      await ask(fixture, { address: "me@shop.example" });
      expect(first.secret!.superseded, "a newer one replaces it").toBe(true);
    });

    it("checks sending at the server typed, keeps the card open with why, and resumes the bot once it sends", async () => {
      const answers = [
        { ok: false, error: "smtp.easy.example didn't answer on 587.", account: { ...readOnly, smtpTried: { smtpHost: "smtp.easy.example", smtpPort: 587 } } },
        { ok: true, account: { ...ACCOUNT, smtpHost: "smtp.easy.example", smtpPort: 587, smtpSecurity: "starttls" } },
      ];
      const fixture = mail({ connected: true, sendingProblem: problem, account: readOnly, checkOutgoing: () => answers.shift() });
      await ask(fixture, { address: "me@shop.example" });
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

    it("the bot hears that the person declined, and still never a value", async () => {
      const fixture = mail({ connected: true, sendingProblem: problem, account: readOnly });
      await ask(fixture, { address: "me@shop.example" });
      const secret = card(fixture).secret!;
      expect(fixture.cards.updateText(card(fixture).id, secret, "dismissed")).toContain("chose not to set up sending for me@shop.example");
      expect(fixture.cards.updateText(card(fixture).id, secret, "provided")).toContain(problem);
    });
  });
});

describe("a secret a linked 1Password holds", () => {
  const TOKEN = "ops_fake-service-account-token";
  const NOTION = "secret_fake-notion-token-123";
  function linked(options: { grants?: Record<string, LoginBots>; fail?: () => Error | null } = {}) {
    const { sdk, calls } = fakeOnePasswordSdk({ token: TOKEN, fail: options.fail, vaults: { v1: { title: "Shared", items: [
      { id: "n1", title: "Notion token", category: "ApiCredentials", urls: [], fields: [{ id: "credential", title: "credential", fieldType: "Concealed", value: NOTION }] },
    ] } } });
    const held: string[] = [];
    const one = fixture(undefined, (vaultStore) => new BotLogins(vaultStore, new OnePasswordLogins({ token: () => TOKEN, grants: () => options.grants ?? {},
      connect: (token) => sdkOnePasswordClient(sdk, token, "0.0.0") }), () => [], (value) => held.push(value)));
    return { ...one, calls, held };
  }
  const ask = (one: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
    one.cards.requestCredential(one.bot, "t1", { label: "notion-token", reason: "For Notion.", delivery: "ref", ...extra });

  it("is handed over by ref with no card, read from 1Password only then, and never saved or shown", async () => {
    const one = linked();
    const answer = await ask(one);
    expect(answer.status).toBe(200);
    expect(one.calls.filter((call) => call === "items.getAll v1 n1")).toHaveLength(2);
    expect(one.held).toEqual([NOTION]);
    const ref = /secret-ref:[0-9a-f]{32}/u.exec(String(answer.body.text))?.[0];
    const used = one.cards.redeemMcpServer({ env: { NOTION_TOKEN: ref } }, "ledger", "t1", "stripe");
    expect(used.ok && used.value).toEqual({ env: { NOTION_TOKEN: expect.stringMatching(/^vault:linked-[0-9a-f]{32}$/u) } });
    expect(one.lines).toEqual([]);
    expect(one.vaultStore.listSecrets(TEAM_READER)).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain(NOTION);
  });

  it("is written to a private file for the bot's commands", async () => {
    const one = linked();
    const answer = await ask(one, { delivery: "file" });
    const file = /to the file (\S+)\. /u.exec(String(answer.body.text))?.[1];
    expect(file?.startsWith(join(one.dataDir, ".openmausbot-secrets", "t1", "vault-linked-"))).toBe(true);
    expect(readFileSync(file!, "utf8")).toBe(NOTION);
    if (process.platform !== "win32") expect(statSync(file!).mode & 0o777).toBe(0o600);
  });

  it("is not for a bot its 1Password vault is kept from, which gets a card instead", async () => {
    const one = linked({ grants: { v1: ["quill"] } });
    expect(await ask(one)).toMatchObject({ status: 201 });
    expect(one.held).toEqual([]);
  });

  it("comes after one saved in the Vault, and isn't read when the bot says it is wrong", async () => {
    const one = linked();
    one.vaultStore.saveSecret({ name: "Notion token", value: "secret_fake-saved", source: "settings", bots: "all" });
    expect((await ask(one)).status).toBe(200);
    expect(await ask(one, { replace: true })).toMatchObject({ status: 201 });
    expect(one.held).toEqual([]);
  });

  it("is offered on a card asking under another name, read from 1Password only when picked", async () => {
    const one = linked();
    const id = String((await ask(one, { label: "Notion workspace key" })).body.messageId);
    expect(one.held).toEqual([]);
    const choices = one.cards.savedChoices("ledger", "t1", id);
    expect(choices).toEqual([{ id: expect.any(String), name: "Notion token", provider: "1password" }]);
    expect(await one.cards.useSavedSecret("ledger", "t1", id, choices[0]!.id)).toMatchObject({ status: 200 });
    expect(one.held).toEqual([NOTION]);
    const ref = /secret-ref:[0-9a-f]{32}/u.exec(one.resumed[0]!)?.[0];
    const used = one.cards.redeemMcpServer({ env: { NOTION_TOKEN: ref } }, "ledger", "t1", "stripe");
    expect(used.ok && used.value).toEqual({ env: { NOTION_TOKEN: expect.stringMatching(/^vault:linked-[0-9a-f]{32}$/u) } });
    expect(one.vaultStore.listSecrets(TEAM_READER)).toEqual([]);
  });

  it("tells the bot in plain words when 1Password can't be read, with no card", async () => {
    let failure: Error | null = null;
    const one = linked({ fail: () => failure });
    await ask(one);
    failure = new Error("getaddrinfo ENOTFOUND my.1password.com");
    expect(await ask(one)).toEqual({ status: 502, body: { error: "notion-token is in a linked password manager, but it could not be read: Could not reach 1Password. Check the internet connection and try again." } });
    expect(one.lines).toEqual([]);
  });
});
