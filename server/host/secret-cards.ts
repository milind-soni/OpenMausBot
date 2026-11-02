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
  botLogins: Pick<BotLogins, "credentialConfig">;
  phoneSecrets: Pick<PhoneSecretBridge, "provide" | "open">;
  phoneSecretSubmissions: PhoneSecretSubmissionRegistry;
  connectorThread(botId: string, threadId: string): { bot: BotRecord; group: GroupRecord | undefined } | null;
  answerCardNode(threadId: string, messageId: string, text: string): boolean;
  dataDir: string;
  /** Admin manages this server's models: an AI provider key cannot be saved here. */
  providerKeysRefused: boolean;
  /** The bot's own folder a turn in this conversation writes to (on a Team Cloud, the member's or room's layer). */
  layerFolder(botId: string, threadId: string): string;
  /** The Local VM (its target key) this conversation's turn holds right now, if any. */
  turnVm(threadId: string): string | undefined;
  /** The language a line in this conversation is written in for its person (server/server-lines.ts). */
  threadLanguage?(threadId: string): string | undefined;
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
    return `The person saved ${label} as ${saved.ref}. Put it in an add_mcp_server env, header or oauth.clientSecret value, alone or inside text such as "Bearer ${saved.ref}": OpenMausBot swaps in the value. It works once, only for you in this conversation, for an hour, and you never see the value.`;
  }
  return `The person saved ${label} to the file ${saved.file}. Read it only inside a command, such as TOKEN="$(cat '${saved.file}')"; never print, echo, log or copy it anywhere else. It is deleted after 24 hours.`;
}

function deliveryNote(botName: string, delivery: SecretDelivery, language: string | undefined): string {
  return serverLine(language, delivery === "file" ? "server.connect.secretFile" : "server.connect.secretRef", { bot: botName });
}

/** Where a file secret goes: the Local VM workspace its card names, else the bot's own folder. */
function vmFileHome(botId: string, vm: string): SecretFileHome | null {
  const pool = /^pool:(\d{1,4})$/.exec(vm);
  const target = vm === SHARED_LOCAL_VM_TARGET.key ? SHARED_LOCAL_VM_TARGET
    : pool ? poolLocalVmTarget(Number(pool[1]))
      : perBotLocalVmTarget(botId).key === vm ? perBotLocalVmTarget(botId) : null;
  return target ? { host: target.workspaceDir, shown: VM_WORKSPACE_GUEST } : null;
}

function customRequest(body: Record<string, unknown>): { label: string; reason: string; placeholder: string; delivery: SecretDelivery } | { error: string } {
  const text = (value: unknown, max: number) => typeof value === "string"
    ? [...value].map((ch) => (ch.charCodeAt(0) < 0x20 || ch === "\u007f" ? " " : ch)).join("").trim().slice(0, max)
    : "";
  const label = text(body.label, CUSTOM_SECRET_LABEL_MAX);
  const reason = text(body.reason, CUSTOM_SECRET_REASON_MAX);
  if (!label) return { error: "request_credential needs credential_id for a key OpenMausBot keeps, or label for any other secret." };
  if (!reason) return { error: "request_credential needs reason: one short line on what the secret is for and where the person finds it." };
  if (!SECRET_DELIVERIES.includes(body.delivery as SecretDelivery)) {
    return { error: "request_credential needs delivery: ref for OpenMausBot's own tools such as add_mcp_server, or file for your own commands." };
  }
  return { label, reason, placeholder: text(body.placeholder, CUSTOM_SECRET_LABEL_MAX), delivery: body.delivery as SecretDelivery };
}

export function createSecretCards(deps: SecretCardsDeps) {
  const { store, cfg, botLogins, phoneSecrets, phoneSecretSubmissions, connectorThread, answerCardNode } = deps;
  const vault = new SecretVault();
  addHeldSecretScrubber((text) => vault.scrub(text));

  const custom = (secret: SecretRequestCardData): boolean => secret.target === CUSTOM_SECRET_TARGET;
  /** Saved where the card says: a named key in the settings or Logins, a custom secret behind its card. */
  const secretSaved = (secret: SecretRequestCardData): boolean =>
    secret.target === CUSTOM_SECRET_TARGET ? secret.savedAt !== undefined : credentialIsConfigured(botLogins.credentialConfig(cfg), secret.target);

  function updateText(messageId: string, secret: SecretRequestCardData, outcome: "provided" | "dismissed"): string {
    if (!custom(secret)) return credentialUpdateText(secret.label, outcome);
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

  /** Keeps a custom card's value where its delivery says, and marks when; never touches the card's other fields. */
  function storeCustomSecret(message: Message, botId: string, threadId: string, value: string): void {
    const secret = message.secret!;
    const owner = { botId, threadId };
    if (secret.delivery === "file") {
      const home = (secret.vm ? vmFileHome(botId, secret.vm) : null) ?? { host: deps.layerFolder(botId, threadId), shown: deps.layerFolder(botId, threadId) };
      vault.saveFile(owner, message.id, value, home);
    } else {
      vault.saveRef(owner, message.id, secret.label, value);
    }
    store.patchMessage(threadId, message.id, { secret: { ...secret, savedAt: Date.now() } });
  }

  /** A value typed into a custom card in the app: kept, then the paused turn resumes. */
  function saveCustomSecret(botId: string, threadId: string, messageId: string, raw: unknown): { status: number; body: Record<string, unknown> } {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return { status: 404, body: { error: "no such credential request" } };
    const secret = message.secret;
    if (!custom(secret)) return { status: 400, body: { error: "this card saves a key in Settings" } };
    if (phoneSecretSubmissions.has(phoneSecretSubmissionKey(threadId, message.id, secret.requestKey))) {
      return { status: 409, body: { error: "this secret is currently being saved from a phone" } };
    }
    if (secret.dismissed) return { status: 409, body: { error: "this request was declined" } };
    if (secret.superseded) return { status: 409, body: { error: "this request was replaced by a newer one" } };
    if (secret.stopped) return { status: 409, body: { error: "this request stopped with its task" } };
    if (secret.provided || secret.savedAt !== undefined) return { status: 409, body: { error: "this secret was already saved" } };
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || Buffer.byteLength(value) > SECRET_VALUE_MAX_BYTES) {
      return { status: 400, body: { error: `Enter the secret: up to ${SECRET_VALUE_MAX_BYTES} bytes.` } };
    }
    try {
      storeCustomSecret(message, botId, threadId, value);
    } catch (error) {
      console.warn(`secret card: could not keep a secret: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 500, body: { error: "The secret could not be kept safely. Nothing was saved." } };
    }
    if (!resumeSecretCard(botId, threadId, message.id, "provided")) return { status: 409, body: { error: "this credential request is no longer available" } };
    return { status: 200, body: currentSecretState(botId, threadId, message.id) ?? { provided: true, resumed: false } };
  }

  /** add_mcp_server's fields with every secretRef swapped for its value: only in env, headers and oauth.clientSecret. */
  function redeemMcpServer<T>(body: T, botId: string, threadId: string) {
    return vault.redeem(body, { botId, threadId }, (path) =>
      (path.length === 2 && (path[0] === "env" || path[0] === "headers")) || (path.length === 2 && path[0] === "oauth" && path[1] === "clientSecret"),
    "add_mcp_server's env, headers and oauth.clientSecret");
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
        storeCustomSecret(current, context.botId, context.threadId, opened);
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
  function requestCredential(from: BotRecord, fromThreadId: string, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const owner = connectorThread(from.id, fromThreadId);
    if (!owner) return { status: 403, body: { error: "source conversation does not belong to sender" } };
    if (body.credentialId === undefined) return requestCustomSecret(from, fromThreadId, Boolean(owner.group), body);
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
        placeholder: target.placeholder,
        helpUrl: target.helpUrl,
        requestKey: randomUUID(),
      },
    });
    for (const prior of store.activePath(fromThreadId)) {
      if (prior.id === message.id) continue;
      if (!prior.secret || !isPendingCredentialRequest(prior, credentialId, from.id, Boolean(owner.group))) continue;
      store.patchMessage(fromThreadId, prior.id, { secret: { ...prior.secret, superseded: true } });
    }
    return { status: 201, body: { messageId: message.id, label: target.label } };
  }

  /** A secret OpenMausBot does not keep: the same bot asking again for one already saved here gets it back, and a newer
   * card replaces its pending one with the same name. */
  function requestCustomSecret(from: BotRecord, threadId: string, room: boolean, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const asked = customRequest(body);
    if ("error" in asked) return { status: 400, body: asked };
    const path = store.activePath(threadId);
    const earlier = [...path].reverse().find((message) => message.kind === "secret" && message.secret && custom(message.secret) &&
      message.secret.savedAt !== undefined && !message.secret.superseded && message.secret.label.toLowerCase() === asked.label.toLowerCase() &&
      (!room || message.from?.botId === from.id));
    const kept = earlier ? vault.savedFor(earlier.id) : null;
    if (earlier && kept && earlier.secret!.delivery === asked.delivery) return { status: 200, body: { label: asked.label, text: savedSecretText(asked.label, kept) } };
    const mismatch = earlier && kept ? earlier.secret!.delivery : undefined;
    const vm = asked.delivery === "file" ? deps.turnVm(threadId) : undefined;
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
    }
    return { status: 201, body: { messageId: message.id, label: asked.label, delivery: asked.delivery, ...(mismatch ? { savedAs: mismatch } : {}) } };
  }

  return {
    phoneSecretSubmissionKey, secretMessage, currentSecretState, resumeSecretCard, provideSecretFromPhone, requestCredential, saveCustomSecret,
    secretSaved, updateText, redeemMcpServer,
  };
}
