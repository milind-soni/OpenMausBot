// The phone-secret provisioning helpers — extracted verbatim from
// index.ts: the submission registry with its bot-deletion mutation claim,
// the desktop handoff prompt, the idempotency submission key, the
// provided/resumed card state read, and provideSecretFromPhone, which walks
// a phone credential submission through the encrypted store, the submission
// registry and the card resume. index.ts wires createTurnSecrets at the
// helpers' original site, after the phoneSecrets bridge const and the
// createDeferredResumes destructure have produced connectorThread,
// secretMessage and resumeSecretCard by value; every caller is an HTTP
// route evaluated long after that wiring.
import { credentialIsConfigured } from "../shared/credential-request.ts";
import {
  PhoneSecretError,
  PhoneSecretSubmissionRegistry,
  assertPhoneSecretRequestMatches,
  phoneSecretOperationId,
  type PhoneSecretBridge,
  type PhoneSecretContext,
} from "./phone-secret.ts";
import { cfg, store } from "./runtime.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";

/** Everything the phone-secret provisioning helpers read from their
 * host. All four are values index.ts binds before the wiring site:
 * phoneSecrets is a const there, and the card helpers come from the
 * createDeferredResumes destructure further up. The submission registry is
 * constructed here: only this factory and the names it returns see it. */
export interface TurnSecretsDeps {
  connectorThread(botId: string, threadId: string): { bot: BotRecord; group: GroupRecord | undefined } | null;
  secretMessage(botId: string, threadId: string, messageId: string): Message | null;
  resumeSecretCard(botId: string, threadId: string, messageId: string, outcome: "provided" | "dismissed"): boolean;
  phoneSecrets: PhoneSecretBridge;
}

export function createTurnSecrets(deps: TurnSecretsDeps) {
  const { connectorThread, secretMessage, resumeSecretCard, phoneSecrets } = deps;
  const phoneSecretSubmissions = new PhoneSecretSubmissionRegistry();

  function phoneSecretSubmissionKey(threadId: string, messageId: string, requestKey: string): string {
    return `${threadId}:${messageId}:${requestKey}`;
  }

  function currentSecretState(botId: string, threadId: string, messageId: string) {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return null;
    return {
      provided: message.secret.provided === true,
      resumed: message.secret.resumed === true,
    };
  }

  async function provideSecretFromPhone(
    context: PhoneSecretContext,
    authenticatedDeviceId: string,
  ): Promise<{ provided: boolean; resumed: boolean }> {
    const owner = connectorThread(context.botId, context.threadId);
    const message = secretMessage(context.botId, context.threadId, context.messageId);
    if (!owner || !message?.secret) throw new PhoneSecretError("No such credential request", 404);
    if (message.secret.dismissed) throw new PhoneSecretError("This credential request was dismissed", 409);
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
    // The encrypted store may have committed immediately before a process
    // interruption. Recording the winning operation precedes completing the
    // card, so the exact retry can repair that tiny window without writing the
    // credential again. A different randomized envelope was rejected above.
    if (message.secret.phoneOperationId === operationId && !message.secret.provided) {
      if (!credentialIsConfigured(cfg, message.secret.target)) {
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
      if (!credentialIsConfigured(cfg, message.secret.target)) {
        throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
      }
      // A crash or older build may have committed the credential and marked
      // the card provided without dispatching its continuation. An exact phone
      // retry repairs that state instead of silently claiming it resumed.
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
      await phoneSecrets.provide(context);
      const current = secretMessage(context.botId, context.threadId, context.messageId);
      if (!current?.secret || current.secret.requestKey !== context.requestKey) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      if (current.secret.dismissed) {
        throw new PhoneSecretError("This credential request was dismissed", 409);
      }
      // Electron acknowledges only after credentials.bin and the server's
      // external-secret config update both commit. Keep this assertion at the
      // boundary so a future parent handler cannot accidentally resume first.
      if (!credentialIsConfigured(cfg, current.secret.target)) {
        throw new PhoneSecretError(`${current.secret.label} was not saved yet`, 409);
      }
      // Persist the winning randomized envelope id before completing the card.
      // A later exact retry can recover a lost response, while a newly sealed
      // value can never be reported as though it were the value already saved.
      store.patchMessage(context.threadId, current.id, {
        secret: { ...current.secret, phoneOperationId: operationId },
      });
      if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
    });
    const settled = currentSecretState(context.botId, context.threadId, context.messageId);
    if (!settled) throw new PhoneSecretError("This credential request is no longer available", 409);
    return settled;
  }

  function claimPhoneSecretBotDeletion(botId: string): (() => void) | null {
    const scopes = [
      { botId },
      ...store.groups
        .filter((group) => group.memberIds.includes(botId))
        .map((group) => ({ groupId: group.id })),
    ];
    const releases: Array<() => void> = [];
    for (const scope of scopes) {
      const release = phoneSecretSubmissions.claimMutation(scope);
      if (!release) {
        for (const undo of releases.reverse()) undo();
        return null;
      }
      releases.push(release);
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  function credentialDesktopHandoff(label: string): string {
    return `Securely provide the ${label} from OpenMausBot on your phone or computer. It is never added to chat.`;
  }

  return {
    phoneSecretSubmissionKey, currentSecretState, provideSecretFromPhone,
    phoneSecretSubmissions, claimPhoneSecretBotDeletion, credentialDesktopHandoff,
  };
}
