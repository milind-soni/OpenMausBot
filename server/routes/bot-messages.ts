import type { ComposerDelivery } from "../../shared/composer-delivery.ts";
import type { ServerResponse } from "node:http";
import { z } from "zod";

import { approvalModeFor } from "../../shared/approval-mode.ts";
import { isPersistentQuestionCard } from "../../shared/ask-question.ts";
import { normalizeReaction, reactionAnswer } from "../../shared/reactions.ts";
import type { WidgetAction } from "../../shared/widget.ts";
import type { ResolvedSender, SteerQueueReason } from "../../shared/wire.ts";
import { admit } from "../admission.ts";
import { dismissQuestionCard } from "../card-dismissal.ts";
import { AppMessageRate, appContextBlock, prepareAppMessage } from "../chat-apps.ts";
import { prepareWidgetPress, reopenCancelledPress } from "../chat-widgets.ts";
import type { ModelSelection, RequestOutcome, SteerOutcome } from "../contracts.ts";
import { parseDataContext, type DataContext } from "../data-context.ts";
import { preparePointed } from "../pointed.ts";
import type { Handoffs } from "../delta-context.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { spokenLineFields } from "../live-call-record.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { ReplyTarget } from "../replies.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import { acceptedSendMatch, parseSendId } from "../send-idempotency.ts";
import { cancelSteeredMessage, holdSteeredQueue, queuedSteeredMessage, restoreHeldSteeredQueue, settleHeldSteeredQueue } from "../steer-queue.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import { extractSteerImages } from "../turn-images.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { pinnedClientThreadGuard } from "./pinned-client-thread.ts";
import { PASS, type RouteHandler } from "./table.ts";

type RunningInstance = ReturnType<ProviderRegistry["get"]>;

type DirectSendReceipt =
  | { ok: false; uncertain: true; steered?: never; threadId: string; message: Message }
  | { ok: true; threadId: string; message: Message; steered?: true }
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: SteerQueueReason };

type SkillResolution =
  | { claimed: false }
  | { claimed: true; status: number; error: string }
  | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true };

type CardAnswer = { botId: string; botName?: string; threadId: string; requestId: string; behavior: string };

type Behavior = "allow" | "deny" | "answer";

export interface BotMessageRouteDeps {
  store: Pick<Store,
    | "activeLeaf" | "appendMessage" | "bot" | "botByThread" | "bots" | "groupByThread" | "messagesFor"
    | "patchMessage" | "patchTask" | "projectBotForTask" | "setActiveLeaf" | "setTaskAskedAt" | "taskByThread" | "tasks">;
  registry: Pick<ProviderRegistry, "get">;
  routines(): RoutineManager | null;
  handoffs: Pick<Handoffs, "current" | "steered" | "stoppedByPerson">;
  phoneSecretSubmissions: Pick<PhoneSecretSubmissionRegistry, "hasThread">;
  directTurnDispatchClaims: { get(threadId: string): { threadId: string } | undefined };
  groupSpeakers: ReadonlyMap<string, { botId: string }>;
  desktopManaged: boolean;
  cloudHome: boolean;
  DirectSendRefused: abstract new (...args: never[]) => { readonly status: number; readonly body: Record<string, unknown> };
  acceptDirectSend(
    input: {
      botId: string; threadId: string; text: string; sendId?: string; replyTo?: Message; sender?: ResolvedSender;
      trigger: UsageTrigger; dataContext?: DataContext; personPresent: boolean; delivery?: ComposerDelivery;
      app?: { context?: string; fromApp?: Message["fromApp"]; pointed?: Message["pointed"] };
    },
    guardedStart?: (currentAtStart: BotRecord) => Promise<DirectSendReceipt>,
  ): Promise<DirectSendReceipt>;
  directSendRefusal(botId: string, threadId: string): { status: number; body: Record<string, unknown> } | null;
  startTurn(botId: string, text: string, opts?: {
    threadId?: string; replyTo?: Message; sendId?: string; sender?: ResolvedSender; trigger?: UsageTrigger; relayed?: boolean;
    dataContext?: DataContext; compactOnly?: boolean; cardContinuation?: boolean; editedMessageId?: string;
  }): Promise<Message>;
  usageTriggerFor(auth: RequestAuth): UsageTrigger;
  messageSender(auth: RequestAuth): ResolvedSender | undefined;
  cloudGuestSendRefusal(auth: RequestAuth, threadId: string): string | null;
  cloudThreadRefusal(auth: RequestAuth, threadId: string): string | null;
  cardAnswerRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null;
  commandRememberRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null;
  requestBehavior(value: unknown): Behavior | null;
  requestedTaskBot(botId: string, rawThreadId: unknown): BotRecord;
  botForThread(botId: string, threadId: string): BotRecord | null;
  threadBusy(botId: string, threadId: string): boolean;
  botAtThreadCapacity(botId: string): boolean;
  parksBehindCoordination(botId: string, threadId: string): boolean;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): RunningInstance;
  engineSteersImages(instance: RunningInstance | undefined): boolean;
  resolveReplyTarget(threadId: string, value: unknown): Message | undefined;
  turnSelection(botId: string, threadId: string): ModelSelection | undefined;
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  clearUnattended(threadId: string): void;
  drainQueuedSends(): void;
  answeringCardAs(auth: RequestAuth, threadId: string, requestId: string, work: () => Promise<unknown>): Promise<void>;
  resolveAndSendTrust(res: ServerResponse, threadId: string, requestId: string, behavior: Behavior): boolean;
  resolveAndSendTeamSetup(res: ServerResponse, args: { botId: string; threadId: string; requestId: string; behavior: string }, ownerReview: boolean): Promise<boolean>;
  resolveAndSendRoutine(res: ServerResponse, args: CardAnswer): boolean;
  resolveAndSendProfile(res: ServerResponse, args: CardAnswer): boolean;
  resolveAndSendModel(res: ServerResponse, args: CardAnswer): boolean;
  resolveSkillRequest(args: CardAnswer & { behavior: Behavior; reviewedSha256?: string }): SkillResolution;
  sendSkillResolution(res: ServerResponse, result: SkillResolution): boolean;
  answerRequest(
    threadId: string, instanceId: string, requestId: string, behavior: Behavior, message?: string,
    decidedFor?: { id: string; name: string }, always?: boolean, rememberCommand?: boolean,
  ): Promise<RequestOutcome>;
  deliverLateQuestionAnswer(auth: RequestAuth, threadId: string, requestId: string, answer: string, cardMessage: Message, owner: BotRecord): Promise<{ queued: boolean }>;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
  cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  closeOpenApprovals(threadId: string): void;
  /** The outcome of a card the harness raised itself (a peer approval, a quota-switch offer); undefined for any other card. */
  harnessCardOutcome(threadId: string, requestId: string, behavior: Behavior, message: unknown): Promise<string | undefined>;
  /** What a press on one of the bot's own server-built cards is about, from the server's records; null leaves the press the person's plain answer. */
  pressRecords(bot: BotRecord, action: WidgetAction): string | null;
  /** A press the server answers itself, with no turn: handled, refused (not the owner or an admin), or null for an ordinary press. */
  serverPress(bot: BotRecord, threadId: string, messageId: string, action: WidgetAction, auth: RequestAuth): "handled" | "refused" | null;
  /** Shows a 👍 or 👎 relayed from another app on the message it answered, as that person's reaction. */
  relayedReaction(threadId: string, messageId: string, person: { email?: string; name?: string }, emoji: string): void;
  /** The conversation an answer to this card belongs to: a run's own, for the copy its automation posted in a chat. */
  answeredIn(threadId: string, requestId: string): string;
}

/** External interfaces (the Slack worker) opt in. `onBehalfOf`, advertised by /api/health as
 * capabilities.guardedOnBehalfOf, books the turn to that person; only this admin-scoped route reads it. `reaction`
 * replaces `text` when the person reacted in that app: a 👍 or 👎 (Slack's name for it, or the emoji any platform
 * sends) on the message in `replyToId`, made by `onBehalfOf`. */
const guardedSendSchema = z.object({
  threadId: z.string().regex(/^[\w-]+$/),
  sendId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  text: z.string().min(1).optional(),
  reaction: z.string().max(64).optional(),
  expectedActiveLeafId: z.string().regex(/^[\w-]+$/).nullable(),
  expectedApprovalMode: z.enum(["ask", "full"]).optional(),
  replyToId: z.string().optional(),
  onBehalfOf: z.object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  }).strict().refine((who) => Boolean(who.email || who.name)).optional(),
}).strict().refine((send) => (send.text === undefined) !== (send.reaction === undefined));

export function createBotMessageRoutes(deps: BotMessageRouteDeps): RouteHandler {
  const {
    store, registry, handoffs, phoneSecretSubmissions, directTurnDispatchClaims, groupSpeakers,
    desktopManaged: DESKTOP_MANAGED, cloudHome: CLOUD_HOME, DirectSendRefused,
    acceptDirectSend, directSendRefusal, startTurn, usageTriggerFor, messageSender, cloudGuestSendRefusal, cloudThreadRefusal,
    cardAnswerRefusal, commandRememberRefusal, requestBehavior, requestedTaskBot, botForThread, threadBusy,
    botAtThreadCapacity, parksBehindCoordination, activeGroupTurnForBot, runningTurnInstance, engineSteersImages, resolveReplyTarget,
    turnSelection, policyModelRefusal, clearUnattended, drainQueuedSends, answeringCardAs, resolveAndSendTrust, resolveAndSendTeamSetup,
    resolveAndSendRoutine, resolveAndSendProfile, resolveAndSendModel, resolveSkillRequest, sendSkillResolution, answerRequest,
    deliverLateQuestionAnswer, interruptDirectThread, cancelDirectTurnDispatch, revokeInternalCapabilitiesForThread,
    cancelGroupTurnOperations, closeOpenApprovals, harnessCardOutcome, pressRecords, serverPress, relayedReaction, answeredIn,
  } = deps;
  const pinnedClientThread = pinnedClientThreadGuard(store);
  /** widget -> sendId of a press on its way in: a second tap before acceptance must not send a second answer. */
  const pressesInFlight = new Map<string, string | undefined>();
  const appMessageRate = new AppMessageRate();
  return async ({ req, res, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const requirePinnedClientThread = pinnedClientThread(auth, req);
    const routines = deps.routines();
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages(?:\/(guarded|explicit))?$/);
    if (m && method === "POST") {
      const guarded = m[2] === "guarded";
      const explicit = m[2] === "explicit";
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const pressed = body.widgetAction !== undefined && body.widgetAction !== null;
      const deliverySchema = z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("queue") }).strict(),
        z.object({ mode: z.literal("steer"), runId: z.string().regex(/^[\w-]{1,100}$/) }).strict(),
      ]);
      const delivery = explicit ? deliverySchema.safeParse(body.delivery) : undefined;
      if (explicit && (!delivery?.success || pressed) || !explicit && body.delivery !== undefined) {
        return json(res, 400, { error: "explicit messages require a valid delivery intent and cannot answer widgets" });
      }
      if (guarded && pressed) return json(res, 400, { error: "guarded sends cannot answer a widget" });
      const fromAnApp = body.appMessage !== undefined && body.appMessage !== null;
      if (guarded && fromAnApp) return json(res, 400, { error: "guarded sends cannot speak for an app" });
      if (pressed && fromAnApp) return json(res, 400, { error: "send widgetAction or appMessage, not both" });
      const pointing = body.pointed !== undefined && body.pointed !== null;
      if (pointing && (guarded || pressed || fromAnApp)) return json(res, 400, { error: "only a typed message can carry what the person pointed at" });
      // A distinct route, so an older server answers 404 instead of ignoring the safety preconditions.
      const guardedBody = guarded ? guardedSendSchema.safeParse(body) : null;
      if (guardedBody && !guardedBody.success) {
        const onBehalfOfInvalid = guardedBody.error.issues.some((issue) => issue.path[0] === "onBehalfOf");
        return json(res, 400, { error: onBehalfOfInvalid
          ? "onBehalfOf must name the person with an email address, a name, or both"
          : "guarded sends require threadId, sendId, text (or a reaction) and expectedActiveLeafId" });
      }
      const relayed = guardedBody?.data?.reaction === undefined ? null : normalizeReaction(guardedBody.data.reaction);
      if (guardedBody?.data?.reaction !== undefined && (!reactionAnswer(relayed) || !body.replyToId || !guardedBody.data.onBehalfOf)) {
        return json(res, 400, { error: "a relayed reaction is a 👍 or 👎 on the message in replyToId, made by the person in onBehalfOf" });
      }
      const typed = pressed || fromAnApp ? "" : relayed ?? String(body.text ?? "").trim();
      if (!pressed && !fromAnApp && !typed) return json(res, 400, { error: "text required" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      requirePinnedClientThread(bot.id, body.threadId);
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      const threadId = body.threadId ?? bot.threadId;
      const notYours = cloudGuestSendRefusal(auth, threadId);
      if (notYours) return json(res, 403, { error: notYours });
      const onBehalfOf = guardedBody?.data?.onBehalfOf;
      const trigger: UsageTrigger = onBehalfOf
        ? { kind: "user", ...(onBehalfOf.email ? { email: onBehalfOf.email } : {}), ...(onBehalfOf.name ? { label: onBehalfOf.name } : {}) }
        : usageTriggerFor(auth);
      // Security invariant: another bot's thread answers like a missing one, before anything reads a widget in it.
      if (pressed && !store.taskByThread(bot.id, threadId)) return json(res, 409, { error: "the bot switched tasks before it could receive the message" });
      const sendId = parseSendId(body.sendId);
      const press = pressed ? prepareWidgetPress(store, threadId, body.widgetAction, sendId) : null;
      if (press && !press.ok) return json(res, press.status, { error: press.error });
      const answered = press ? serverPress(bot, threadId, press.messageId, press.action, auth) : null;
      if (answered === "handled") return json(res, 202, { ok: true, threadId, handled: true });
      if (answered === "refused") return json(res, 403, { error: "Only the owner or an admin can do that." });
      // acceptDirectSend checks these again; nothing awaits between.
      const refused = directSendRefusal(bot.id, threadId);
      if (refused) return json(res, refused.status, refused.body);
      const appSent = fromAnApp ? prepareAppMessage(store, threadId, body.appMessage) : null;
      if (appSent && !appSent.ok) return json(res, appSent.status, { error: appSent.error });
      const pointed = pointing ? preparePointed(store, threadId, body.pointed) : null;
      if (pointed && !pointed.ok) return json(res, pointed.status, { error: pointed.error });
      const text = press ? press.text : appSent ? appSent.text : typed;
      const target = resolveReplyTarget(threadId, press ? press.messageId : appSent ? appSent.messageId : body.replyToId);
      if (relayed && target?.role !== "bot") return json(res, 400, { error: "a relayed reaction answers a bot's message" });
      // Only a real press or reaction, or an app's own words, marks the reply; a typed reply to the same row never does, whatever its words.
      const records = press && target ? pressRecords(bot, press.action) : null;
      const replyTo: ReplyTarget | undefined = press && target ? { ...target, widgetPress: { label: press.label, action: press.action, ...(records ? { records } : {}) } }
        : appSent && target ? { ...target, appMessage: { title: appSent.title, origin: appSent.origin } }
          : relayed && target ? { ...target, reactedWith: relayed } : target;
      const pressKey = press?.settles ? `${threadId}:${press.messageId}` : undefined;
      if (pressKey && pressesInFlight.has(pressKey) && !(sendId && pressesInFlight.get(pressKey) === sendId)) {
        return json(res, 409, { error: "That answer is already on its way." });
      }
      const dataContext = press || appSent ? undefined : parseDataContext(body.dataContext);
      const retried = Boolean(sendId && (store.messagesFor(threadId).some((message) => message.sendId === sendId) || queuedSteeredMessage(bot.id, threadId, sendId)));
      const slot = appSent ? appMessageRate.reserve(`${threadId}:${appSent.messageId}`, sendId) : null;
      if (appSent && !slot) return json(res, 429, { error: "This app has sent too many messages. Wait a while, or type your message." });
      // A relay is not the person at this screen: it never carries what their apps last showed.
      const appContext = guarded || retried ? null : appContextBlock(store, threadId);
      const context = `${appContext?.block ?? ""}${pointed?.block ?? ""}`;
      const app = context || appSent || pointed
        ? {
            ...(context ? { context } : {}),
            ...(appSent ? { fromApp: { messageId: appSent.messageId, title: appSent.title } } : {}),
            ...(pointed ? { pointed: pointed.refs } : {}),
          }
        : undefined;
      const sender = messageSender(auth);
      const guardedStart = guarded
        ? async (currentAtStart: BotRecord): Promise<DirectSendReceipt> => {
            // No await between these checks and startTurn: never steer or enqueue under stale permissions.
            const expectedMode = body.expectedApprovalMode ?? "ask";
            if (approvalModeFor(currentAtStart) !== expectedMode ||
                (expectedMode === "ask" && (currentAtStart.autoApprove === true || currentAtStart.alwaysAllow?.length))) {
              throw Object.assign(new Error("guarded sends require the exact expected approval mode; Ask cannot have remembered permissions"), { status: 409, code: "guarded_permissions" });
            }
            if (store.activeLeaf(threadId) !== body.expectedActiveLeafId) {
              throw Object.assign(new Error("the conversation changed before this message could start"), { status: 409, code: "guarded_branch" });
            }
            const guardedAdmission = admit("guarded", {}, {
              botBusy: currentAtStart.busy,
              threadBusy: threadBusy(bot.id, threadId),
              atCapacity: botAtThreadCapacity(bot.id),
              parksBehindCoordination: parksBehindCoordination(bot.id, threadId),
              groupTurn: Boolean(activeGroupTurnForBot(bot.id)),
            });
            if (guardedAdmission.action === "refuse") {
              throw Object.assign(new Error("wait for a free thread slot before retrying this message"), { status: 409, code: "guarded_busy" });
            }
            const message = await startTurn(bot.id, text, { threadId, replyTo, sendId, sender, trigger, relayed: true, dataContext });
            return { ok: true as const, threadId, message };
          }
        : undefined;
      if (pressKey) pressesInFlight.set(pressKey, sendId);
      try {
        const receipt = await acceptDirectSend({
          botId: bot.id, threadId, text, sendId, replyTo, sender, trigger, dataContext, ...(app ? { app } : {}),
          ...(delivery?.success ? { delivery: delivery.data } : {}),
          // The bot's own shell reaches this route on a headless server (loopback is the owner), so only a
          // paired session or the desktop capability proves a person and lifts the webhook block.
          personPresent: auth.kind === "session" || DESKTOP_MANAGED,
        }, guardedStart);
        press?.settle("queueId" in receipt ? receipt.queueId : undefined);
        appContext?.deliver();
        if (relayed && target && onBehalfOf) relayedReaction(threadId, target.id, onBehalfOf, relayed);
        return json(res, 202, receipt);
      } catch (error) {
        slot?.release();
        if (error instanceof DirectSendRefused) return json(res, error.status, error.body);
        throw error;
      } finally {
        if (pressKey) pressesInFlight.delete(pressKey);
      }
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      const queueId = m[2];
      if (!cancelSteeredMessage(bot.id, queueId, bot.threadId)) {
        return json(res, 404, { error: "no such queued message" });
      }
      reopenCancelledPress(store, bot.threadId, queueId);
      return json(res, 200, { ok: true });
    }

    // Steers a queued message into the running turn without interrupting it; engines without live steer keep the queue.
    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      // Hold the whole queue atomically: a racing settle drains it or this request steers it, never both.
      const held = holdSteeredQueue(bot.id, bot.threadId, m[2]);
      if (!held) return json(res, 404, { error: "no such queued message" });
      const currentAtStart = store.projectBotForTask(bot.id, bot.threadId);
      const instance = currentAtStart?.busy ? runningTurnInstance(currentAtStart, bot.threadId) : undefined;
      const engineCanSteer = Boolean(currentAtStart?.busy && instance?.adapter.capabilities.queueing && instance.adapter.steer);
      const steerInput = extractSteerImages(held.items.map((item) => item.prompt));
      const steerAdmission = admit("direct-busy", {
        carriesImages: !steerInput || steerInput.images.length > 0,
        engineCanSteerImages: Boolean(steerInput) && engineSteersImages(instance),
        engineCanSteer,
      });
      if (steerAdmission.action === "queue" && steerAdmission.blockedBy) {
        restoreHeldSteeredQueue(held);
        return json(res, 200, { ok: true, queued: true, threadId: bot.threadId, blockedBy: steerAdmission.blockedBy });
      }
      const prompt = (steerInput?.texts ?? held.items.map((item) => item.prompt)).join("\n\n");
      const images = steerInput?.images ?? [];
      const steerTarget = handoffs.current(bot.threadId);
      let steered: SteerOutcome = "refused";
      if (steerAdmission.action === "steer" && instance?.adapter.steer) {
        steered = await (images.length > 0
          ? instance.adapter.steer(bot.threadId, prompt, images)
          : instance.adapter.steer(bot.threadId, prompt))
          .catch((): SteerOutcome => "indeterminate");
      }
      // The steer awaited adapter work: re-read every ownership invariant before writing anything.
      const current = store.projectBotForTask(bot.id, bot.threadId);
      // "indeterminate" never restores: the words may already be in the live turn, and a replay would run them twice.
      if (
        (steered === "steered" && current?.busy ||
          steered === "indeterminate" && current) &&
        store.taskByThread(bot.id, bot.threadId)
      ) {
        if (auth.kind === "session" || DESKTOP_MANAGED) clearUnattended(bot.threadId);
        const messages = held.items.map((item) => store.appendMessage(bot.threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          composerDelivery: item.composerDelivery,
          ...(item.dataContext ? { dataContext: item.dataContext } : {}),
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          steered: true,
          ...(steered === "indeterminate" ? { steerUncertain: true } : {}),
          sender: item.sender,
          ...spokenLineFields(item.via, item.callId),
          ...(item.fromApp ? { fromApp: item.fromApp } : {}),
        }));
        const asked = messages.filter((_, index) => !held.items[index]?.unattended && !held.items[index]?.peerAsk).at(-1);
        if (asked) store.setTaskAskedAt(bot.id, bot.threadId, asked.at);
        for (const message of messages) handoffs.steered(bot.threadId, steerTarget, instance?.instanceId, message.id);
        const queueIds = held.items.map((item) => item.messageId);
        settleHeldSteeredQueue(held);
        return json(res, 200, { ...(steered === "indeterminate" ? { ok: false, uncertain: true } : { ok: true, steered: true }), threadId: bot.threadId, messages, queueIds });
      }
      if (steered === "indeterminate") {
        // No destination left: settle, so a restart cannot replay words a dead turn may have run.
        settleHeldSteeredQueue(held);
        if (!store.taskByThread(bot.id, bot.threadId)) {
          throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
        }
        throw Object.assign(new Error("no such bot"), { status: 404 });
      }
      restoreHeldSteeredQueue(held);
      if (current && !current.busy) drainQueuedSends();
      return json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/compact$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      const notYours = cloudThreadRefusal(auth, bot.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      await startTurn(bot.id, "Summarize conversation context", {
        threadId: bot.threadId, compactOnly: true, cardContinuation: true, trigger: usageTriggerFor(auth),
      });
      return json(res, 202, { ok: true, threadId: bot.threadId });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      const notYours = cloudThreadRefusal(auth, bot.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const threadMessages = store.messagesFor(bot.threadId);
      const source = threadMessages.find((msg) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        return json(res, 404, { error: "only user messages can be edited" });
      }
      // Before the busy guard: a retried edit's own fork is what is busy.
      const sendId = parseSendId(body.sendId);
      if (sendId) {
        const accepted = acceptedSendMatch(threadMessages, sendId, text, source.replyToId);
        if (accepted.kind === "conflict" || (accepted.kind === "match" && (accepted.message.parentId ?? null) !== (source.parentId ?? null))) {
          return json(res, 409, { error: "sendId already belongs to another message" });
        }
        if (accepted.kind === "match") return json(res, 202, { ok: true, message: accepted.message });
      }
      // Synchronous from here: startTurn flips busy before the next request, so two racing edits cannot both pass.
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before editing" });
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      const rerunSelection = turnSelection(bot.id, bot.threadId) ?? bot.modelSelection;
      if (!registry.get(rerunSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${rerunSelection.instanceId}" is unavailable — pick another model in settings`,
        });
      }
      const rerunInstance = registry.get(rerunSelection.instanceId)!;
      const rerunRefusal = policyModelRefusal(rerunInstance);
      if (rerunRefusal) return json(res, 409, { error: rerunRefusal });
      const quoted = source.replyToId ? resolveReplyTarget(bot.threadId, source.replyToId) : undefined;
      const replyTo: ReplyTarget | undefined = quoted && source.reaction && text === source.text ? { ...quoted, reactedWith: source.reaction } : quoted;
      const dataContext = parseDataContext(body.dataContext) ?? (text === source.text ? source.dataContext : undefined);
      const message = await startTurn(bot.id, text, { threadId: bot.threadId, editedMessageId: messageId, replyTo, sendId, trigger: usageTriggerFor(auth), dataContext,
        ...(CLOUD_HOME ? { sender: messageSender(auth) } : {}) });
      return json(res, 202, { ok: true, message });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      const notYours = cloudThreadRefusal(auth, bot.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before switching versions" });
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      store.patchTask(bot.id, bot.threadId, { rewound: true });
      return json(res, 200, { activeLeafId: leaf });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const selected = requestedTaskBot(m[1], body.threadId);
      const bot = botForThread(selected.id, answeredIn(selected.threadId, String(body.requestId)))!;
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      const refusal = cardAnswerRefusal(auth, selected.threadId, String(body.requestId), behavior) ??
        (selected.threadId === bot.threadId ? null : cardAnswerRefusal(auth, bot.threadId, String(body.requestId), behavior));
      if (refusal) return json(res, 403, { error: refusal });
      if (body.rememberCommand === true) {
        const refusal = commandRememberRefusal(auth, bot.threadId, String(body.requestId), behavior);
        if (refusal) return json(res, 403, { error: refusal });
      }
      return await answeringCardAs(auth, bot.threadId, String(body.requestId), async () => {
        if (resolveAndSendTrust(res, bot.threadId, String(body.requestId), behavior)) return;
        if (await resolveAndSendTeamSetup(res, {
          botId: bot.id, threadId: bot.threadId, requestId: String(body.requestId), behavior,
        }, auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return;
        if (resolveAndSendRoutine(res, {
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
        })) return;
        if (resolveAndSendProfile(res, {
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
        })) return;
        if (resolveAndSendModel(res, {
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
        })) return;
        if (sendSkillResolution(res, resolveSkillRequest({
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
          reviewedSha256,
        }))) return;
        const requestId = String(body.requestId);
        const own = await harnessCardOutcome(bot.threadId, requestId, behavior, body.message);
        if (own) return json(res, 200, { ok: true, outcome: own });
        const pending = store.messagesFor(bot.threadId).find((message) => message.card?.requestId === requestId);
        const dismissed = dismissQuestionCard(store, bot.threadId, pending, body);
        if (dismissed) return json(res, dismissed.status, dismissed.body);
        const outcome = await answerRequest(bot.threadId, bot.modelSelection.instanceId, requestId, behavior, body.message, { id: bot.id, name: bot.name }, body.always === true, body.rememberCommand === true);
        if (outcome === "unavailable" && isPersistentQuestionCard(pending?.card) && behavior === "answer") {
          if (!pending) return json(res, 404, { error: "this question is no longer available" });
          const answer = typeof body.message === "string" ? body.message.trim() : "";
          if (!answer) return json(res, 400, { error: "a question answer is required" });
          try {
            const reply = await deliverLateQuestionAnswer(auth, bot.threadId, requestId, answer, pending, bot);
            return json(res, 200, { ok: true, outcome: "answered", late: true, ...(reply.queued ? { queued: true } : {}) });
          } catch (error) {
            return json(res, 409, { error: error instanceof Error ? error.message : "the late answer could not be queued" });
          }
        }
        return json(res, 200, { ok: true, outcome });
      });
    }
    m = path.match(/^\/api\/threads\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      const requestId = String(body.requestId);
      const threadId = answeredIn(m[1], requestId);
      const refusal = cardAnswerRefusal(auth, m[1], requestId, behavior) ?? (threadId === m[1] ? null : cardAnswerRefusal(auth, threadId, requestId, behavior));
      if (refusal) return json(res, 403, { error: refusal });
      if (body.rememberCommand === true) {
        const refusal = commandRememberRefusal(auth, threadId, requestId, behavior);
        if (refusal) return json(res, 403, { error: refusal });
      }
      return await answeringCardAs(auth, threadId, requestId, async () => {
        if (resolveAndSendTrust(res, threadId, requestId, behavior)) return;
        const skillCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.skillRequest,
        );
        if (skillCard?.card?.skillRequest) {
          const skillBotId = skillCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!skillBotId) return json(res, 400, { error: "this skill request has no valid owner" });
          const skillOwner = store.bot(skillBotId);
          if (sendSkillResolution(res, resolveSkillRequest({
            botId: skillBotId,
            botName: skillOwner?.name,
            threadId,
            requestId,
            behavior,
            reviewedSha256,
          }))) return;
        }
        const routineCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.routineRequest,
        );
        if (routineCard?.card?.routineRequest) {
          // Derive the owner from the conversation, never from the payload being authorized.
          const routineBotId = routineCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!routineBotId) return json(res, 400, { error: "this routine request has no valid owner" });
          const routineOwner = store.bot(routineBotId);
          if (resolveAndSendRoutine(res, {
            botId: routineBotId,
            botName: routineOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        const setupCard = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.teamSetupRequest);
        if (setupCard) {
          const setupBotId = setupCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!setupBotId) return json(res, 400, { error: "This team setup has no valid owner" });
          if (await resolveAndSendTeamSetup(res, { botId: setupBotId, threadId, requestId, behavior },
            auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return;
        }
        const profileCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.profileRequest,
        );
        if (profileCard?.card?.profileRequest) {
          const profileBotId = profileCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!profileBotId) return json(res, 400, { error: "this profile request has no valid owner" });
          const profileOwner = store.bot(profileBotId);
          if (resolveAndSendProfile(res, {
            botId: profileBotId,
            botName: profileOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        const modelCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.modelRequest,
        );
        if (modelCard?.card?.modelRequest) {
          const modelBotId = modelCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!modelBotId) return json(res, 400, { error: "this model request has no valid owner" });
          const modelOwner = store.bot(modelBotId);
          if (resolveAndSendModel(res, {
            botId: modelBotId,
            botName: modelOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        const own = await harnessCardOutcome(threadId, requestId, behavior, body.message);
        if (own) return json(res, 200, { ok: true, outcome: own });
        const group = store.groupByThread(threadId);
        const pending = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
        const dismissed = dismissQuestionCard(store, threadId, pending, body);
        if (dismissed) return json(res, dismissed.status, dismissed.body);
        const persistentQuestion = isPersistentQuestionCard(pending?.card);
        const owner = group
          ? persistentQuestion
            ? (pending?.from ? store.bot(pending.from.botId) : undefined)
            : (groupSpeakers.get(threadId) ? store.bot(groupSpeakers.get(threadId)!.botId) : undefined) ??
              (pending?.from ? store.bot(pending.from.botId) : undefined)
          : store.botByThread(threadId);
        // A surviving question belongs to its original asker, never a later speaker.
        if (group && persistentQuestion && !owner) {
          return json(res, 409, { error: "the bot that asked this question is no longer available" });
        }
        if (!owner && !pending) return json(res, 404, { error: "nothing is waiting on an answer in this conversation" });
        const requestOwner = owner ? botForThread(owner.id, threadId) : null;
        const outcome = await answerRequest(threadId, requestOwner?.modelSelection.instanceId ?? "", requestId, behavior, body.message, owner ? { id: owner.id, name: owner.name } : undefined, body.always === true, body.rememberCommand === true);
        if (outcome === "unavailable" && isPersistentQuestionCard(pending?.card) && behavior === "answer") {
          if (!pending?.card) return json(res, 404, { error: "this question is no longer available" });
          const answer = typeof body.message === "string" ? body.message.trim() : "";
          if (!answer) return json(res, 400, { error: "a question answer is required" });
          if (!owner) return json(res, 409, { error: "the bot that asked this question is no longer available" });
          try {
            const reply = await deliverLateQuestionAnswer(auth, threadId, requestId, answer, pending, owner);
            return json(res, 200, { ok: true, outcome: "answered", late: true, ...(reply.queued ? { queued: true } : {}) });
          } catch (error) {
            return json(res, 409, { error: error instanceof Error ? error.message : "the late answer could not be queued" });
          }
        }
        return json(res, 200, { ok: true, outcome });
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      requirePinnedClientThread(bot.id, body.threadId);
      const expectedThreadId = body.threadId;
      if (expectedThreadId !== undefined && (typeof expectedThreadId !== "string" || !/^[\w-]+$/.test(expectedThreadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      if (typeof expectedThreadId === "string" && store.taskByThread(bot.id, expectedThreadId)) {
        const routine = routines!.activeBotRunForBot(bot.id);
        if (routine?.threadId === expectedThreadId) await routines!.cancelRun(routine.id);
        else {
          handoffs.stoppedByPerson(expectedThreadId);
          await interruptDirectThread(bot.id, expectedThreadId);
        }
        return json(res, 200, { ok: true });
      }
      const directClaim = directTurnDispatchClaims.get(bot.threadId);
      const routineRun = routines!.activeBotRunForBot(bot.id);
      if (routineRun) {
        if (expectedThreadId !== undefined && routineRun.threadId !== expectedThreadId) {
          return json(res, 409, { error: "this bot is running a routine in another conversation" });
        }
        cancelDirectTurnDispatch(bot.id, routineRun.threadId ?? expectedThreadId);
        if (routineRun.threadId) {
          revokeInternalCapabilitiesForThread(routineRun.threadId);
        }
        await routines!.cancelRun(routineRun.id);
        return json(res, 200, { ok: true });
      }
      const instance = registry.get((botForThread(bot.id, expectedThreadId ?? bot.threadId) ?? bot).modelSelection.instanceId);
      const busyGroup = activeGroupTurnForBot(bot.id);
      if (busyGroup) {
        if (expectedThreadId !== undefined && busyGroup.threadId !== expectedThreadId) {
          return json(res, 409, { error: `this bot is working in channel ${busyGroup.group.name}` });
        }
        cancelGroupTurnOperations(busyGroup.group.id, busyGroup.threadId);
        revokeInternalCapabilitiesForThread(busyGroup.threadId);
        await instance?.adapter.interruptTurn(busyGroup.threadId).catch(() => {});
        closeOpenApprovals(busyGroup.threadId);
        return json(res, 200, { ok: true });
      }
      if (
        expectedThreadId !== undefined &&
        !busyGroup &&
        bot.threadId !== expectedThreadId &&
        directClaim?.threadId !== expectedThreadId
      ) {
        return json(res, 409, { error: "the bot switched tasks before it could be interrupted" });
      }
      handoffs.stoppedByPerson(expectedThreadId ?? bot.threadId);
      await interruptDirectThread(bot.id, expectedThreadId ?? bot.threadId);
      return json(res, 200, { ok: true });
    }
    return PASS;
  };
}
