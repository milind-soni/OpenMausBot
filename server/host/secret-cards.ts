import { userError } from "../user-errors.ts";
// The secure credential cards request_credential adds: the card on the conversation's visible branch, settling it,
// resuming the turn it paused, and the value a paired phone sealed for this computer. No card, message or log holds the value.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  CREDENTIAL_TARGETS,
  CUSTOM_SECRET_LABEL_MAX,
  CUSTOM_SECRET_REASON_MAX,
  CUSTOM_SECRET_TARGET,
  SECRET_DELIVERIES,
  credentialIsConfigured,
  isCredentialTargetId,
  isPendingCredentialRequest,
  isPendingCustomSecretRequest,
  isProviderCredentialTarget,
  type CredentialTargetId,
  type SecretDelivery,
} from "../../shared/credential-request.ts";
import { EMAIL_CREDENTIAL, outgoingFieldsOf, type EmailAccountView, type EmailConnectAnswer, type EmailConnectRequest, type EmailOutgoingAnswer, type EmailOutgoingFields, type EmailServerFields } from "../../shared/email.ts";
import type { SecretRequestCardData } from "../../shared/wire.ts";
import type { AppConfig } from "../config.ts";
import { perBotLocalVmTarget, poolLocalVmTarget, SHARED_LOCAL_VM_TARGET, VM_WORKSPACE_GUEST } from "../container-computer.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { addHeldSecretScrubber } from "../redact.ts";
import { SECRET_VALUE_MAX_BYTES, SecretVault, type SavedSecret, type SecretFileHome } from "../secret-vault.ts";
import {
  PHONE_SECRET_PROTOCOL_VERSION,
  PhoneSecretError,
  assertPhoneSecretRequestMatches,
  phoneSecretOperationId,
  type PhoneSecretBridge,
  type PhoneSecretContext,
  type PhoneSecretSubmissionRegistry,
} from "../phone-secret.ts";
import type { BotLogins } from "../bot-logins.ts";
import type { VaultStore } from "../vault-store.ts";
import { loginUsableBy } from "../../shared/logins.ts";
import { vaultNameKey, type VaultChoice } from "../../shared/vault.ts";
import { fittingChoices } from "../vault/choices.ts";
import { linkedSecretNames } from "../vault/providers.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import { serverLine } from "../server-lines.ts";

export const phoneSecretEnvelopeSchema = z.object({
  version: z.literal(PHONE_SECRET_PROTOCOL_VERSION),
  threadId: z.string().regex(/^[\w-]{1,128}$/),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  deviceId: z.string().regex(/^[\w-]{1,128}$/),
  target: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  requestKey: z.string().regex(/^[\w-]{1,128}$/),
  encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,5483}$/),
}).strict();

export interface SecretCardsDeps {
  store: Pick<Store, "activePath" | "appendMessage" | "patchMessage" | "messagesFor" | "botByThread" | "groupByThread" | "onChange">;
  cfg: AppConfig;
  botLogins: Pick<BotLogins, "credentialConfig" | "linkedSecret"> & Partial<Pick<BotLogins, "linkedSecrets">>;
  /** Where a custom card's value is saved, and found again the next time the same bot asks for it by name. */
  vaultStore: Pick<VaultStore, "saveSecret" | "usableSecret" | "markUsed" | "listSecrets" | "secret" | "updateSecret">;
  phoneSecrets: Pick<PhoneSecretBridge, "provide" | "open">;
  phoneSecretSubmissions: PhoneSecretSubmissionRegistry;
  connectorThread(botId: string, threadId: string): { bot: BotRecord; group: GroupRecord | undefined } | null;
  answerCardNode(threadId: string, messageId: string, text: string): boolean;
  /** A newer card replaced `from`: a turn parked on it waits on `to`. */
  followCard(threadId: string, from: string, to: string): void;
  dataDir: string;
  /** Admin manages this server's models: an AI provider key cannot be saved here. */
  providerKeysRefused: boolean;
  /** The bot's own folder a turn in this conversation writes to (on a Team Cloud, the member's or room's layer). */
  layerFolder(botId: string, threadId: string): string;
  /** The Local VM (its target key) this conversation's turn holds right now, if any. */
  turnVm(threadId: string): string | undefined;
  /** The language a line in this conversation is written in for its person (server/server-lines.ts). */
  threadLanguage?(threadId: string): string | undefined;
  /** The Email connector the mailbox card saves to: connecting proves it reads a real header before anything is kept. */
  email?: {
    connect(request: EmailConnectRequest, reading?: (imapHost: string) => void): Promise<EmailConnectAnswer>;
    /** Why a mailbox can't be connected here, if so. */
    refusal(): string | undefined;
    /** Already connected and working. */
    connected(address: string): boolean;
    /** Why a connected mailbox can't send, if it can't. */
    sendingProblem(address: string): string | undefined;
    /** A connected mailbox, without its password. */
    account(address: string): EmailAccountView | undefined;
    /** Checks sending again at the outgoing server given, and keeps it once it sends, as the mailbox's own form does. */
    checkOutgoing(address: string, fields: EmailOutgoingFields): Promise<EmailOutgoingAnswer>;
    /** The person's own address, the likeliest mailbox when the bot names none. */
    profileAddress(): string | undefined;
  };
}

export type SecretCards = ReturnType<typeof createSecretCards>;

const SWEEP_MS = 10 * 60 * 1000;

const credentialUpdateText = (label: string, outcome: "provided" | "dismissed"): string => outcome === "provided"
  ? `OpenMausBot credential update: the user securely provided ${label}. Continue the task that paused for it. You do not receive the secret and must not ask them to paste it into chat.`
  : `OpenMausBot credential update: the user declined to provide ${label}. Continue without it if possible, or briefly explain the limitation. Do not ask them to paste it into chat.`;

/** What the bot is told a saved custom secret is, and how to use it without ever seeing or showing the value. */
export function savedSecretText(label: string, saved: SavedSecret | null): string {
  if (!saved) return `The person saved ${label}, but it expired or OpenMausBot restarted before you used it. Ask again with request_credential if you still need it.`;
  if ("ref" in saved) {
    return `The person saved ${label} as ${saved.ref}. Put it in an mcp_server env, header or oauth.clientSecret value, alone or inside text such as "Bearer ${saved.ref}": OpenMausBot swaps in the value. It works once, only for you in this conversation, for an hour, and you never see the value.`;
  }
  return `The person saved ${label} to the file ${saved.file}. Read it only inside a command, such as TOKEN="$(cat '${saved.file}')"; never print, echo, log or copy it anywhere else. It is deleted after 24 hours.`;
}

function deliveryNote(botName: string, delivery: SecretDelivery, language: string | undefined): string {
  return `${serverLine(language, delivery === "file" ? "server.connect.secretFile" : "server.connect.secretRef", { bot: botName })} ${serverLine(language, "server.connect.secretKept", { bot: botName })}`;
}

/** Where a file secret goes: the Local VM workspace its card names, else the bot's own folder. */
function vmFileHome(botId: string, vm: string): SecretFileHome | null {
  const pool = /^pool:(\d{1,4})$/.exec(vm);
  const target = vm === SHARED_LOCAL_VM_TARGET.key ? SHARED_LOCAL_VM_TARGET
    : pool ? poolLocalVmTarget(Number(pool[1]))
      : perBotLocalVmTarget(botId).key === vm ? perBotLocalVmTarget(botId) : null;
  return target ? { host: target.workspaceDir, shown: VM_WORKSPACE_GUEST } : null;
}

/** What the bot hears when the mailbox card settles; it never hears the password. */
function emailUpdateText(secret: SecretRequestCardData, outcome: "provided" | "dismissed", sendingProblem: string | undefined): string {
  if (outcome === "dismissed") return "OpenMausBot secret update: the person chose not to connect a mailbox. Say briefly what you cannot do without it, and do not ask for the password in chat.";
  const address = secret.address ?? "they typed";
  return sendingProblem
    ? `OpenMausBot secret update: the person connected the mailbox ${address} for reading: EMAIL_LIST_MESSAGES, EMAIL_READ_MESSAGE and the other reading tools are ready. Sending from it doesn't work yet: ${sendingProblem} The mailbox card in this chat now shows its outgoing server for the person to fix. Continue the task as far as reading allows; don't try to send another way.`
    : `OpenMausBot secret update: the person connected the mailbox ${address}. The email tools (EMAIL_LIST_MESSAGES, EMAIL_READ_MESSAGE, EMAIL_SEND_MESSAGE and others) are ready. Continue the task that paused for it.`;
}

/** What the bot hears when the outgoing-server card settles; it never hears a password either. */
function emailOutgoingUpdateText(address: string, outcome: "provided" | "dismissed", sendingProblem: string | undefined): string {
  if (outcome === "dismissed") return `OpenMausBot secret update: the person chose not to set up sending for ${address}. Reading still works. Say briefly what you can't do without sending; don't send another way or ask for the password in chat.`;
  return sendingProblem
    ? `OpenMausBot secret update: the person tried another outgoing server for ${address}, and sending still doesn't work: ${sendingProblem} Tell them in one line and carry on without sending.`
    : `OpenMausBot secret update: sending from ${address} works now; EMAIL_SEND_MESSAGE is ready. Continue the task that paused for it.`;
}

const OUTGOING_FIELDS = ["smtpHost", "smtpPort", "smtpSecurity", "smtpUsername", "smtpPassword"] as const;

const SERVER_FIELDS = ["imapHost", "imapPort", "smtpHost", "smtpPort", "smtpSecurity", "username", "smtpUsername", "smtpPassword"] as const;
function emailServerFields(fields: Record<string, unknown>): EmailServerFields {
  const out: Record<string, unknown> = {};
  for (const name of SERVER_FIELDS) {
    const value = fields[name];
    if (name === "smtpSecurity") { if (value === "tls" || value === "starttls") out[name] = value; }
    else if (name === "smtpPassword") { if (typeof value === "string" && value && Buffer.byteLength(value) <= SECRET_VALUE_MAX_BYTES) out[name] = value; }
    else if ((name.endsWith("Port") && Number.isInteger(value)) || (!name.endsWith("Port") && typeof value === "string" && value.trim())) out[name] = value;
  }
  return out as EmailServerFields;
}

function outgoingFields(fields: Record<string, unknown>): EmailOutgoingFields {
  const server = emailServerFields(fields) as Record<string, unknown>;
  return Object.fromEntries(OUTGOING_FIELDS.flatMap((name) => (server[name] === undefined ? [] : [[name, server[name]]]))) as EmailOutgoingFields;
}

function customRequest(body: Record<string, unknown>): { label: string; reason: string; placeholder: string; delivery: SecretDelivery; replace: boolean } | { error: string } {
  const text = (value: unknown, max: number) => typeof value === "string"
    ? [...value].map((ch) => (ch.charCodeAt(0) < 0x20 || ch === "\u007f" ? " " : ch)).join("").trim().slice(0, max)
    : "";
  const label = text(body.label, CUSTOM_SECRET_LABEL_MAX);
  const reason = text(body.reason, CUSTOM_SECRET_REASON_MAX);
  if (!label) return { error: "request_credential needs credential_id for a key OpenMausBot keeps, or label for any other secret." };
  if (!reason) return { error: "request_credential needs reason: one short line on what the secret is for and where the person finds it." };
  if (!SECRET_DELIVERIES.includes(body.delivery as SecretDelivery)) {
    return { error: "request_credential needs delivery: ref for OpenMausBot's own tools such as mcp_server, or file for your own commands." };
  }
  return { label, reason, placeholder: text(body.placeholder, CUSTOM_SECRET_LABEL_MAX), delivery: body.delivery as SecretDelivery, replace: body.replace === true };
}

export function createSecretCards(deps: SecretCardsDeps) {
  const { store, cfg, botLogins, vaultStore, phoneSecrets, phoneSecretSubmissions, connectorThread, answerCardNode } = deps;
  const vault = new SecretVault();
  addHeldSecretScrubber((text) => vault.scrub(text));

  const custom = (secret: SecretRequestCardData): boolean => secret.target === CUSTOM_SECRET_TARGET;
  /** Saved where the card says: a named key in the settings or Logins, a custom secret behind its card. */
  const secretSaved = (secret: SecretRequestCardData): boolean =>
    secret.target === CUSTOM_SECRET_TARGET ? secret.savedAt !== undefined : credentialIsConfigured(botLogins.credentialConfig(cfg), secret.target);

  function updateText(messageId: string, secret: SecretRequestCardData, outcome: "provided" | "dismissed"): string {
    if (!custom(secret)) return credentialUpdateText(secret.label, outcome);
    if (secret.delivery === "email" && secret.emailOutgoing && secret.address) return emailOutgoingUpdateText(secret.address, outcome, deps.email?.sendingProblem(secret.address));
    if (secret.delivery === "email") return emailUpdateText(secret, outcome, secret.address ? deps.email?.sendingProblem(secret.address) : undefined);
    return outcome === "provided"
      ? `OpenMausBot secret update: ${savedSecretText(secret.label, vault.savedFor(messageId))} Continue the task that paused for it.`
      : `OpenMausBot secret update: the person declined to provide ${secret.label}. Continue without it if you can, or say briefly what you cannot do. Do not ask for it in chat.`;
  }

  function sweepBases(): string[] {
    const under = (folder: string) => {
      try {
        return readdirSync(folder).map((name) => join(folder, name));
      } catch {
        return [];
      }
    };
    return [...under(join(deps.dataDir, "workspaces")), join(deps.dataDir, "vm-home"), ...under(join(deps.dataDir, "vm-homes"))];
  }
  const threadExists = (threadId: string) => Boolean(store.botByThread(threadId) || store.groupByThread(threadId));
  const savedAt = (threadId: string, messageId: string) =>
    store.messagesFor(threadId).find((message) => message.id === messageId)?.secret?.savedAt ?? null;
  const sweep = () => {
    try {
      vault.sweep(sweepBases(), savedAt, threadExists);
    } catch (error) {
      console.warn(`secret files: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  sweep();
  setInterval(sweep, SWEEP_MS).unref();
  store.onChange((change) => {
    if (change.type === "thread.deleted" || change.type === "bot.deleted" || change.type === "group.deleted") sweep();
  });

  const fileHome = (botId: string, threadId: string, vm: string | undefined): SecretFileHome =>
    (vm ? vmFileHome(botId, vm) : null) ?? { host: deps.layerFolder(botId, threadId), shown: deps.layerFolder(botId, threadId) };

  /** Saves a custom card's value to the Vault for the asking bot, then hands it over. */
  function storeCustomSecret(message: Message, botId: string, threadId: string, value: string): void {
    vaultStore.saveSecret({ name: message.secret!.label, value, source: "card", bots: [botId], refOnly: message.secret!.delivery !== "file" });
    handOver(message, botId, threadId, value);
  }

  /** Hands a custom card's value over as its delivery says, and marks when; never touches the card's other fields. */
  function handOver(message: Message, botId: string, threadId: string, value: string): void {
    const secret = message.secret!;
    const owner = { botId, threadId };
    if (secret.delivery === "file") {
      vault.saveFile(owner, message.id, value, fileHome(botId, threadId, secret.vm));
    } else {
      vault.saveRef(owner, message.id, secret.label, value);
    }
    store.patchMessage(threadId, message.id, { secret: { ...secret, savedAt: Date.now() } });
  }

  /** A custom card still waiting for its value, or why it can't take one. */
  function openCustomCard(botId: string, threadId: string, messageId: string): Message | { status: number; body: Record<string, unknown> } {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return { status: 404, body: { ...userError("serverError.secret.missing") } };
    const secret = message.secret;
    if (!custom(secret)) return { status: 400, body: { ...userError("serverError.secret.settingsCard") } };
    if (phoneSecretSubmissions.has(phoneSecretSubmissionKey(threadId, message.id, secret.requestKey))) {
      return { status: 409, body: { ...userError("serverError.secret.savingFromPhone") } };
    }
    if (secret.dismissed) return { status: 409, body: { ...userError("serverError.secret.declined") } };
    if (secret.superseded) return { status: 409, body: { ...userError("serverError.secret.replaced") } };
    if (secret.stopped) return { status: 409, body: { ...userError("serverError.secret.taskStopped") } };
    if (secret.provided || secret.savedAt !== undefined) return { status: 409, body: { ...userError("serverError.secret.alreadySaved") } };
    return message;
  }

  /** A value typed into a custom card in the app: kept, then the paused turn resumes. */
  function saveCustomSecret(botId: string, threadId: string, messageId: string, raw: unknown): { status: number; body: Record<string, unknown> } {
    const message = openCustomCard(botId, threadId, messageId);
    if ("status" in message) return message;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || Buffer.byteLength(value) > SECRET_VALUE_MAX_BYTES) {
      return { status: 400, body: { ...userError("serverError.secret.valueSize", { bytes: SECRET_VALUE_MAX_BYTES }) } };
    }
    try {
      storeCustomSecret(message, botId, threadId, value);
    } catch (error) {
      console.warn(`secret card: could not keep a secret: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 500, body: { ...userError("serverError.secret.notKeptSafely") } };
    }
    if (!resumeSecretCard(botId, threadId, message.id, "provided")) return { status: 409, body: { ...userError("serverError.secret.unavailableLower") } };
    return { status: 200, body: currentSecretState(botId, threadId, message.id) ?? { provided: true, resumed: false } };
  }

  /** "Use a saved one" on a custom card: saved secrets and the bot's linked ones whose names could fit, never the one by
   * this very name the bot may already use (it would have had it with no card, so the bot wants a new value). A secret
   * given only to OpenMausBot's own tools is never offered for a file. */
  function savedChoices(botId: string, threadId: string, messageId: string): Array<VaultChoice & { use(): Promise<string> }> {
    const message = openCustomCard(botId, threadId, messageId);
    if ("status" in message || message.secret!.delivery === "email") return [];
    const card = message.secret!;
    const asked = vaultNameKey(card.label);
    const fresh = (name: string, usable: boolean) => !(usable && vaultNameKey(name) === asked);
    const saved = vaultStore.listSecrets().filter((one) => !(card.delivery === "file" && one.refOnly) && fresh(one.name, loginUsableBy(one, botId)))
      .map((one) => ({ id: one.id, name: one.name, use: async () => {
        // Picking it is the person letting this bot use it.
        if (one.bots !== "all" && !one.bots.includes(botId)) vaultStore.updateSecret(one.id, { bots: [...one.bots, botId] });
        const value = vaultStore.secret(one.id)?.value;
        if (!value) throw new Error(`${one.name} is no longer in the Vault.`);
        vaultStore.markUsed(one.id);
        return value;
      } }));
    const linked = (botLogins.linkedSecrets?.() ?? []).filter((one) => loginUsableBy(one, botId)).flatMap((one) => linkedSecretNames(one)
      .filter(({ name }) => fresh(name, true)).map(({ name }) => ({ id: `${one.id}#${name}`, name, provider: one.provider, use: async () => {
        const read = await botLogins.linkedSecret(name, botId);
        if (!read) throw new Error(`${name} is no longer in the linked password manager.`);
        return read.value;
      } })));
    return fittingChoices(card.label, [...saved, ...linked]);
  }

  /** The person picked a saved secret on the card: the bot may use it from now on, gets it as the card's delivery says,
   * and its paused turn resumes. */
  async function useSavedSecret(botId: string, threadId: string, messageId: string, itemId: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const open = openCustomCard(botId, threadId, messageId);
    if ("status" in open) return open;
    const choice = savedChoices(botId, threadId, messageId).find((one) => one.id === itemId);
    if (!choice) return { status: 404, body: { ...userError("serverError.secret.unavailableLower") } };
    let value: string;
    try { value = await choice.use(); }
    catch (error) { return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } }; }
    const message = openCustomCard(botId, threadId, messageId);
    if ("status" in message) return message;
    try {
      handOver(message, botId, threadId, value);
    } catch (error) {
      console.warn(`secret card: could not hand over a saved secret: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 500, body: { ...userError("serverError.secret.notKeptSafely") } };
    }
    if (!resumeSecretCard(botId, threadId, message.id, "provided")) return { status: 409, body: { ...userError("serverError.secret.unavailableLower") } };
    return { status: 200, body: currentSecretState(botId, threadId, message.id) ?? { provided: true, resumed: false } };
  }

  /** The mailbox card: the password goes to the Email connector, which reads a real header before keeping it. A wrong one
   * leaves the card open with why, so the person isn't sent back to a new card. */
  async function saveEmailSecret(botId: string, threadId: string, messageId: string, fields: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret || message.secret.delivery !== "email") return { status: 404, body: userError("serverError.secret.missing") };
    const secret = message.secret;
    if (phoneSecretSubmissions.has(phoneSecretSubmissionKey(threadId, message.id, secret.requestKey))) return { status: 409, body: userError("serverError.secret.savingFromPhone") };
    if (secret.dismissed) return { status: 409, body: userError("serverError.secret.declined") };
    if (secret.superseded) return { status: 409, body: userError("serverError.secret.replaced") };
    if (secret.stopped) return { status: 409, body: userError("serverError.secret.taskStopped") };
    if (secret.provided || secret.savedAt !== undefined) return { status: 409, body: userError("serverError.secret.mailboxAlreadyConnected") };
    if (secret.emailOutgoing) return saveOutgoingServer(botId, threadId, message.id, secret.address, outgoingFields(fields));
    const password = typeof fields.value === "string" ? fields.value : "";
    const address = typeof fields.address === "string" && fields.address.trim() ? fields.address.trim() : secret.address ?? "";
    if (!address || !password.trim() || Buffer.byteLength(password) > SECRET_VALUE_MAX_BYTES) return { status: 400, body: userError("serverError.secret.emailAndPassword") };
    if (!deps.email) return { status: 409, body: userError("serverError.secret.emailUnavailable") };
    const reading = (emailReading: string) => {
      const card = secretMessage(botId, threadId, messageId);
      if (card?.secret && card.secret.savedAt === undefined) store.patchMessage(threadId, message.id, { secret: { ...card.secret, emailReading } });
    };
    const answer = await deps.email.connect({ address, password, ...emailServerFields(fields) }, reading);
    const current = secretMessage(botId, threadId, messageId);
    if (!answer.ok) {
      if (current?.secret?.emailReading) { const { emailReading: _reading, ...rest } = current.secret; store.patchMessage(threadId, message.id, { secret: rest }); }
      return { status: 400, body: { error: answer.error, ...(answer.needsServer ? { needsServer: true } : {}), ...(answer.signIn ? { signIn: answer.signIn } : {}) } };
    }
    if (!current?.secret) return { status: 409, body: userError("serverError.secret.unavailableLower") };
    store.patchMessage(threadId, message.id, { secret: { ...current.secret, address: answer.account.address, emailReading: answer.account.imapHost, savedAt: Date.now() } });
    if (!resumeSecretCard(botId, threadId, message.id, "provided")) return { status: 409, body: userError("serverError.secret.unavailableLower") };
    return { status: 200, body: { ...currentSecretState(botId, threadId, message.id), ...(answer.sending.ok ? {} : { sendingProblem: answer.sending.problem }) } };
  }

  /** The outgoing-server card: sending is checked at the server typed, and kept once it sends, as the mailbox's own form
   * does. One that still can't send leaves the card open with why. */
  async function saveOutgoingServer(botId: string, threadId: string, messageId: string, address: string | undefined, fields: EmailOutgoingFields): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!address || !deps.email) return { status: 409, body: userError("serverError.secret.emailUnavailable") };
    const answer = await deps.email.checkOutgoing(address, fields);
    const current = secretMessage(botId, threadId, messageId);
    if (!current?.secret) return { status: 409, body: userError("serverError.secret.unavailableLower") };
    if (!answer.ok) {
      if (answer.account) store.patchMessage(threadId, messageId, { secret: { ...current.secret, emailOutgoing: outgoingFieldsOf(answer.account) } });
      return { status: 400, body: { error: answer.error } };
    }
    store.patchMessage(threadId, messageId, { secret: { ...current.secret, emailOutgoing: outgoingFieldsOf(answer.account), savedAt: Date.now() } });
    if (!resumeSecretCard(botId, threadId, messageId, "provided")) return { status: 409, body: userError("serverError.secret.unavailableLower") };
    return { status: 200, body: currentSecretState(botId, threadId, messageId) ?? { provided: true, resumed: false } };
  }

  /** mcp_server's fields with every secretRef swapped for its value: only in env, headers and oauth.clientSecret. */
  function redeemMcpServer<T>(body: T, botId: string, threadId: string) {
    return vault.redeem(body, { botId, threadId }, (path) =>
      (path.length === 2 && (path[0] === "env" || path[0] === "headers")) || (path.length === 2 && path[0] === "oauth" && path[1] === "clientSecret"),
    "mcp_server's env, headers and oauth.clientSecret");
  }

  function phoneSecretSubmissionKey(threadId: string, messageId: string, requestKey: string): string {
    return `${threadId}:${messageId}:${requestKey}`;
  }

  function credentialDesktopHandoff(label: string, language: string | undefined): string {
    return serverLine(language, "server.connect.secretHandoff", { label });
  }

  function secretMessage(botId: string, threadId: string, messageId: string): Message | null {
    const owner = connectorThread(botId, threadId);
    if (!owner) return null;
    // Actionable only on the visible branch; in a channel only the requesting bot may bind the credential into HPKE AAD or resume its turn.
    const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
    if (owner.group && message?.from?.botId !== botId) return null;
    return message?.kind === "secret" && message.secret ? message : null;
  }

  function currentSecretState(botId: string, threadId: string, messageId: string) {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return null;
    return {
      provided: message.secret.provided === true,
      resumed: message.secret.resumed === true,
    };
  }

  function resumeSecretCard(botId: string, threadId: string, messageId: string, outcome: "provided" | "dismissed") {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return false;
    if (message.secret.resumed) return true;
    const resumed = answerCardNode(threadId, messageId, updateText(message.id, message.secret, outcome));
    store.patchMessage(threadId, message.id, {
      secret: {
        ...message.secret,
        provided: outcome === "provided" ? true : message.secret.provided,
        dismissed: outcome === "dismissed" ? true : message.secret.dismissed,
        ...(resumed ? { resumed: true, error: undefined } : {}),
      },
    });
    return true;
  }

  async function provideSecretFromPhone(
    context: PhoneSecretContext,
    authenticatedDeviceId: string,
  ): Promise<{ provided: boolean; resumed: boolean }> {
    const owner = connectorThread(context.botId, context.threadId);
    const message = secretMessage(context.botId, context.threadId, context.messageId);
    if (!owner || !message?.secret) throw new PhoneSecretError("No such credential request", 404);
    if (message.secret.dismissed) throw new PhoneSecretError("This credential request was dismissed", 409);
    if (message.secret.superseded) throw new PhoneSecretError("This credential request was superseded by a newer one", 409);
    assertPhoneSecretRequestMatches(context, authenticatedDeviceId, {
      target: message.secret.target,
      requestKey: message.secret.requestKey,
    });
    const operationId = phoneSecretOperationId(context);
    if (message.secret.phoneOperationId && message.secret.phoneOperationId !== operationId) {
      throw new PhoneSecretError(
        "This credential request was already completed by another submission",
        409,
      );
    }
    // Recording the winning operation precedes completing the card, so an exact retry repairs a crash without writing the credential again.
    if (message.secret.phoneOperationId === operationId && !message.secret.provided) {
      if (!secretSaved(message.secret)) {
        throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
      }
      if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
      if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
      return recovered;
    }
    if (message.secret.provided) {
      if (message.secret.phoneOperationId !== operationId) {
        throw new PhoneSecretError(
          "This credential request was already completed by another submission",
          409,
        );
      }
      if (!secretSaved(message.secret)) {
        throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
      }
      if (!message.secret.resumed && !resumeSecretCard(
        context.botId,
        context.threadId,
        context.messageId,
        "provided",
      )) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
      if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
      return recovered;
    }

    const submissionKey = phoneSecretSubmissionKey(context.threadId, context.messageId, context.requestKey);
    await phoneSecretSubmissions.run({
      cardKey: submissionKey,
      botId: context.botId,
      threadId: context.threadId,
      ...(owner.group ? { groupId: owner.group.id } : {}),
    }, operationId, async () => {
      // A custom secret is opened here and kept behind its card; a named key goes to the desktop's store and settings.
      const opened = custom(message.secret!) ? await phoneSecrets.open(context) : null;
      if (opened === null) await phoneSecrets.provide(context);
      const current = secretMessage(context.botId, context.threadId, context.messageId);
      if (!current?.secret || current.secret.requestKey !== context.requestKey) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      if (current.secret.dismissed) {
        throw new PhoneSecretError("This credential request was dismissed", 409);
      }
      // The card may have been superseded during the save: completing it would leave two cards resolved.
      if (current.secret.superseded) {
        throw new PhoneSecretError("This credential request was superseded by a newer one", 409);
      }
      if (opened !== null) {
        if (current.secret.stopped) throw new PhoneSecretError("This request stopped with its task", 409);
        if (current.secret.delivery === "email") {
          if (!current.secret.address || !deps.email) throw new PhoneSecretError(serverLine(deps.threadLanguage?.(context.threadId), "server.connect.emailOnComputer"), 409);
          const answer = current.secret.emailOutgoing
            ? await deps.email.checkOutgoing(current.secret.address, { ...current.secret.emailOutgoing, smtpPassword: opened })
            : await deps.email.connect({ address: current.secret.address, password: opened });
          if (!answer.ok) throw new PhoneSecretError(answer.error, 400);
          store.patchMessage(context.threadId, current.id, { secret: { ...current.secret, savedAt: Date.now() } });
        } else storeCustomSecret(current, context.botId, context.threadId, opened);
      }
      const saved = secretMessage(context.botId, context.threadId, context.messageId) ?? current;
      // Electron acknowledges only after credentials.bin and the config update both commit; keep this assertion so no handler resumes first.
      if (!saved.secret || !secretSaved(saved.secret)) {
        throw new PhoneSecretError(`${current.secret.label} was not saved yet`, 409);
      }
      // Persist the winning envelope id before completing the card, so a new sealed value is never reported as the saved one.
      store.patchMessage(context.threadId, current.id, {
        secret: { ...saved.secret, phoneOperationId: operationId },
      });
      if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
    });
    const settled = currentSecretState(context.botId, context.threadId, context.messageId);
    if (!settled) throw new PhoneSecretError("This credential request is no longer available", 409);
    return settled;
  }

  /** request_credential's card: the id is the whole authority, and a newer request supersedes the pending ones. */
  async function requestCredential(from: BotRecord, fromThreadId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const owner = connectorThread(from.id, fromThreadId);
    if (!owner) return { status: 403, body: { error: "source conversation does not belong to sender" } };
    if (body.credentialId === undefined) return requestCustomSecret(from, fromThreadId, Boolean(owner.group), body);
    if (body.credentialId === EMAIL_CREDENTIAL) return requestEmailCard(from, fromThreadId, Boolean(owner.group), body);
    if (!isCredentialTargetId(body.credentialId)) {
      return { status: 400, body: { error: "unsupported credential id" } };
    }
    const credentialId: CredentialTargetId = body.credentialId;
    const target = CREDENTIAL_TARGETS[credentialId];
    if (credentialIsConfigured(botLogins.credentialConfig(cfg), credentialId)) {
      return { status: 200, body: { alreadyConfigured: true, label: target.label } };
    }
    if (deps.providerKeysRefused && isProviderCredentialTarget(credentialId)) return { status: 403, body: { error: HOSTED_PROVIDER_SETTINGS_ERROR } };
    // A later request supersedes pending cards; the fresh card is appended FIRST, so a failed save leaves the prior cards actionable.
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
    const language = deps.threadLanguage?.(fromThreadId);
    const message = store.appendMessage(fromThreadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(target.label, language),
      ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: {
        target: credentialId,
        label: target.label,
        description: `${reason ? `${target.description} ${reason}` : target.description} ${serverLine(language, "server.connect.secretNeverRead", { bot: from.name })}`,
        ...(credentialId === "greenferenceApiKey" || credentialId === "modelgoApiKey" || credentialId === "geminiTtsKey" ? {
          descriptionParts: {
            baseCode: credentialId === "greenferenceApiKey" ? "secretCard.greenference.description" as const : credentialId === "modelgoApiKey" ? "secretCard.modelgo.description" as const : "secretCard.geminiTts.description" as const,
            reason,
            bot: from.name,
          },
        } : {}),
        placeholder: target.placeholder,
        helpUrl: target.helpUrl,
        requestKey: randomUUID(),
      },
    });
    for (const prior of store.activePath(fromThreadId)) {
      if (prior.id === message.id) continue;
      if (!prior.secret || !isPendingCredentialRequest(prior, credentialId, from.id, Boolean(owner.group))) continue;
      store.patchMessage(fromThreadId, prior.id, { secret: { ...prior.secret, superseded: true } });
      deps.followCard(fromThreadId, prior.id, message.id);
    }
    return { status: 201, body: { messageId: message.id, label: target.label } };
  }

  /** One card for a mailbox's address and password, as a custom card so a phone shows it as it does any secret. */
  function requestEmailCard(from: BotRecord, threadId: string, room: boolean, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const refusal = deps.email ? deps.email.refusal() : "Email can't be connected here.";
    if (refusal || !deps.email) return { status: 403, body: { error: refusal } };
    const named = typeof body.address === "string" && /^[^\s@]+@[^\s@]+$/u.test(body.address.trim()) ? body.address.trim() : undefined;
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, CUSTOM_SECRET_REASON_MAX) : "";
    const language = deps.threadLanguage?.(threadId);
    if (named && deps.email.connected(named)) {
      const sending = deps.email.sendingProblem(named);
      if (!sending) return { status: 200, body: { alreadyConfigured: true, label: named, text: `${named} is already connected. Use the email tools.` } };
      const account = deps.email.account(named);
      const note = serverLine(language, "server.connect.emailOutgoingNote", { bot: from.name });
      const label = postEmailCard(from, threadId, room, {
        label: serverLine(language, "server.connect.emailOutgoingLabel", { address: named }),
        description: `${reason ? `${reason} ` : ""}${sending} ${note}`,
        ...(reason ? { reason: `${reason} ${note}` } : {}),
        placeholder: serverLine(language, "server.connect.emailOutgoingPlaceholder"),
        address: named,
        emailOutgoing: account ? outgoingFieldsOf(account) : {},
      });
      return { status: 201, body: { ...label, delivery: "email", outgoing: true } };
    }
    const address = named ?? deps.email.profileAddress();
    const note = serverLine(language, "server.connect.emailNote", { bot: from.name });
    const label = postEmailCard(from, threadId, room, {
      label: serverLine(language, "server.connect.emailLabel"),
      description: `${reason ? `${reason} ` : ""}${note}`,
      ...(reason ? { reason: `${reason} ${note}` } : {}),
      placeholder: serverLine(language, "server.connect.emailPlaceholder"),
      ...(address ? { address } : {}),
    });
    return { status: 201, body: { ...label, delivery: "email" } };
  }

  /** Posts a mailbox card, which a newer one with the same title replaces while both wait. */
  function postEmailCard(from: BotRecord, threadId: string, room: boolean,
    card: Pick<SecretRequestCardData, "label" | "description" | "reason" | "placeholder" | "address" | "emailOutgoing">): { messageId: string; label: string } {
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(card.label, deps.threadLanguage?.(threadId)),
      ...(room ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: { target: CUSTOM_SECRET_TARGET, helpUrl: "", delivery: "email", requestKey: randomUUID(), ...card },
    });
    for (const prior of store.activePath(threadId)) {
      if (prior.id === message.id || !prior.secret || !isPendingCustomSecretRequest(prior, card.label, from.id, room)) continue;
      store.patchMessage(threadId, prior.id, { secret: { ...prior.secret, superseded: true } });
    }
    return { messageId: message.id, label: card.label };
  }

  /** A secret the Vault holds for the bot by this name, saved or from a linked password manager, is handed over at once,
   * with no card; otherwise a card asks for it, replacing the bot's pending card with the same name. */
  async function requestCustomSecret(from: BotRecord, threadId: string, room: boolean, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const asked = customRequest(body);
    if ("error" in asked) return { status: 400, body: asked };
    const vm = asked.delivery === "file" ? deps.turnVm(threadId) : undefined;
    const saved = asked.replace ? null : vaultStore.usableSecret(asked.label, from.id, asked.delivery);
    let item: { id: string; name: string; value: string } | null = saved;
    if (!asked.replace && !item) {
      try {
        item = await botLogins.linkedSecret(asked.label, from.id);
      } catch (error) {
        return { status: 502, body: { error: `${asked.label} is in a linked password manager, but it could not be read: ${error instanceof Error ? error.message : String(error)}` } };
      }
    }
    if (item) {
      const owner = { botId: from.id, threadId };
      try {
        const handed = asked.delivery === "file" ? { file: vault.mintFile(owner, item.id, item.value, fileHome(from.id, threadId, vm)) } : { ref: vault.mintRef(owner, item.name, item.value) };
        if (saved) vaultStore.markUsed(saved.id);
        return { status: 200, body: { label: asked.label, text: savedSecretText(asked.label, handed) } };
      } catch (error) {
        console.warn(`secret card: could not hand over a saved secret: ${error instanceof Error ? error.message : String(error)}`);
        return { status: 500, body: userError("serverError.secret.notKeptSafely") };
      }
    }
    const path = store.activePath(threadId);
    const language = deps.threadLanguage?.(threadId);
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(asked.label, language),
      ...(room ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: {
        target: CUSTOM_SECRET_TARGET,
        label: asked.label,
        description: `${asked.reason} ${deliveryNote(from.name, asked.delivery, language)}`,
        reason: asked.reason,
        placeholder: asked.placeholder,
        helpUrl: "",
        delivery: asked.delivery,
        ...(vm ? { vm } : {}),
        requestKey: randomUUID(),
      },
    });
    for (const prior of path) {
      if (!prior.secret || !isPendingCustomSecretRequest(prior, asked.label, from.id, room)) continue;
      store.patchMessage(threadId, prior.id, { secret: { ...prior.secret, superseded: true } });
      deps.followCard(threadId, prior.id, message.id);
    }
    const savedAs = asked.delivery === "file" && !asked.replace && vaultStore.usableSecret(asked.label, from.id, "ref") ? { savedAs: "ref" } : {};
    return { status: 201, body: { messageId: message.id, label: asked.label, delivery: asked.delivery, ...savedAs } };
  }

  return {
    phoneSecretSubmissionKey, secretMessage, currentSecretState, resumeSecretCard, provideSecretFromPhone, requestCredential, saveCustomSecret, saveEmailSecret,
    secretSaved, updateText, redeemMcpServer, useSavedSecret,
    /** Names only: what the card shows under "Use a saved one". */
    savedChoices: (botId: string, threadId: string, messageId: string): VaultChoice[] =>
      savedChoices(botId, threadId, messageId).map(({ id, name, provider }) => ({ id, name, ...(provider ? { provider } : {}) })),
  };
}
