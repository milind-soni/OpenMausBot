// The bot thread-operation HTTP routes (the direct bot chat send with
// sendId idempotency and live/queued steering, queued-message cancel
// and steer, message edit with branch fork, active-branch switch, the
// per-bot and per-thread approval/respond endpoints, and bot
// interrupt), extracted verbatim from index.ts's dispatch chain.
// Path matching, methods, and status codes are unchanged; the handler
// returns false for anything it does not own so the chain falls
// through in the same order. The module's call site sits exactly
// where the family sat in index.ts — after the bot cards block and
// immediately before the bot-tasks module — so dispatch order is
// unchanged. (The room-level message routes in ./messages.ts are a
// separate family that runs earlier and is untouched.) The turn
// helpers, resolution services and registries are index-local and
// cross via deps: routines is a late-bound thunk over index.ts's
// let; store/cfg/registry are live bindings from ../runtime.ts; the
// steer-queue, send-idempotency and turn-admission helpers are
// imported from their source modules; requirePinnedClientThread is
// rebuilt per request from ./messages.ts with the same (auth, req)
// pair index.ts passed it. index.ts's `return json(...)` statements
// became `json(...); return true;` (json returns void) and the bare
// `return;`s after the resolve-and-send helpers became `return
// true;` — the same request-terminated meaning they had as returns
// from index.ts's handleRequest.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { createRequirePinnedClientThread } from "./messages.ts";
import { messageSender, type RequestAuth } from "../request-auth.ts";
import { assertWithinBudget } from "../spend.ts";
import { cancelledChatFollowup } from "../message-db.ts";
import { promptWithReply } from "../replies.ts";
import {
  acceptedSendMatch,
  parseSendId,
  sendFingerprint,
  type SendSequencer,
} from "../send-idempotency.ts";
import {
  cancelSteeredMessage,
  holdSteeredQueue,
  queuedSteeredMessage,
  queueSteeredMessage,
  restoreHeldSteeredQueue,
  settleHeldSteeredQueue,
} from "../steer-queue.ts";
import { resolvePeerComms, type ApprovalBus } from "../peer-approval.ts";
import { extractTurnImages } from "../turn-images.ts";
import { computerSelectionTurns, revokeInternalCapabilitiesForThread } from "../internal-capabilities.ts";
import { answerRequest, closeOpenApprovals, requestBehavior } from "../turn-fold.ts";
import { cfg, registry, store } from "../runtime.ts";
import { handoffs } from "../delta-handoffs.ts";
import { DATA_DIR } from "../config.ts";
import {
  botForThread,
  directTurnDispatchClaims,
  requestedTaskBot,
  threadBusy,
} from "../turn-admission.ts";
import type { SteerOutcome } from "../contracts.ts";
import type { Message } from "../store.ts";
import type { RoutineManager } from "../routines.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { createStartTurn } from "../start-turn.ts";
import type { createTurnCleanup } from "../turn-cleanup.ts";
import type { createTurnIntegrations } from "../turn-integrations.ts";
import type { createGroupTurnOperations } from "../group-turn-operations.ts";
import type { createComputerLifecycle } from "../computer-lifecycle.ts";

type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;
type GroupTurnOperations = ReturnType<typeof createGroupTurnOperations>;
type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;
type StartTurn = ReturnType<typeof createStartTurn>;
type TurnCleanup = ReturnType<typeof createTurnCleanup>;

/** index.ts's resolveSkillRequest result shape, mirrored so the dep
 *  pair (producer + sender) can be typed without exporting it. */
type SkillResolution =
  | { claimed: false }
  | { claimed: true; status: number; error: string }
  | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true };

export function createBotThreadOpsRoutes(deps: {
  routines: () => RoutineManager | null;
  DESKTOP_MANAGED: boolean;
  noteTurnTrigger: (threadId: string, auth: RequestAuth) => void;
  sendSequencer: SendSequencer;
  resolveReplyTarget: (threadId: string, value: unknown) => Message | undefined;
  clearUnattended: (threadId: string) => void;
  drainQueuedSends: () => void;
  startOrQueueDirectMessage: (
    botId: string,
    threadId: string,
    text: string,
    replyTo?: Message,
    sendId?: string,
    sender?: { name: string },
  ) => Promise<{ ok: boolean; queued?: boolean; queueId?: string; threadId: string; reason?: "capacity" | undefined; message?: unknown }>;
  phoneSecretSubmissions: PhoneSecretSubmissionRegistry;
  startTurn: StartTurn["startTurn"];
  resolveAndSendTeamSetup: (
    res: ServerResponse,
    args: { botId: string; threadId: string; requestId: string; behavior: string },
    ownerReview: boolean,
  ) => Promise<boolean>;
  resolveAndSendRoutine: (
    res: ServerResponse,
    args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
  ) => boolean;
  resolveAndSendProfile: (
    res: ServerResponse,
    args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
  ) => boolean;
  resolveSkillRequest: (args: {
    botId: string;
    botName?: string;
    threadId: string;
    requestId: string;
    behavior: "allow" | "deny" | "answer";
    reviewedSha256?: string;
  }) => SkillResolution;
  sendSkillResolution: (res: ServerResponse, result: SkillResolution) => boolean;
  approvalBus: ApprovalBus;
  interruptDirectThread: TurnCleanup["interruptDirectThread"];
  cancelDirectTurnDispatch: TurnIntegrations["cancelDirectTurnDispatch"];
  activeGroupTurnForBot: GroupTurnOperations["activeGroupTurnForBot"];
  cancelGroupTurnOperations: GroupTurnOperations["cancelGroupTurnOperations"];
  runningTurnInstance: ComputerLifecycle["runningTurnInstance"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, auth } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      routines,
      DESKTOP_MANAGED,
      noteTurnTrigger,
      sendSequencer,
      resolveReplyTarget,
      clearUnattended,
      drainQueuedSends,
      startOrQueueDirectMessage,
      phoneSecretSubmissions,
      startTurn,
      resolveAndSendTeamSetup,
      resolveAndSendRoutine,
      resolveAndSendProfile,
      resolveSkillRequest,
      sendSkillResolution,
      approvalBus,
      interruptDirectThread,
      cancelDirectTurnDispatch,
      activeGroupTurnForBot,
      cancelGroupTurnOperations,
      runningTurnInstance,
    } = deps;
    const requirePinnedClientThread = createRequirePinnedClientThread(auth, req);
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const text = String(body.text ?? "").trim();
      if (!text) { json(res, 400, { error: "text required" }); return true; }
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      requirePinnedClientThread(bot.id, body.threadId);
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        json(res, 400, { error: "threadId must be a task id" });
        return true;
      }
      // A retry carries its original task. That lets us return the canonical
      // receipt after a task switch, while a genuinely new send still has to
      // target the task that is active now.
      const threadId = body.threadId ?? bot.threadId;
      noteTurnTrigger(threadId, auth);
      // The send is acknowledged before the turn starts, so a workspace at its
      // spend limit is refused here, where the person can see it.
      try {
        assertWithinBudget(cfg, DATA_DIR);
      } catch (error) {
        json(res, 409, { error: error instanceof Error ? error.message : String(error), code: "spend_cap" });
        return true;
      }
      if (!store.taskByThread(bot.id, threadId)) {
        json(res, 409, { error: "the bot switched tasks before it could receive the message" });
        return true;
      }
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      const receiptPromise = sendSequencer.run(
        sendId ? `bot:${bot.id}:${threadId}:${sendId}` : undefined,
        sendFingerprint(text, replyTo?.id),
        async () => {
          if (sendId) {
            if (cancelledChatFollowup("bot", bot.id, threadId, sendId)) {
              throw Object.assign(new Error("this queued sendId was cancelled; send a new message to try again"), { status: 409 });
            }
            const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, replyTo?.id);
            if (accepted.kind === "conflict") {
              throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
            }
            if (accepted.kind === "match") {
              const canonical = {
                ok: true as const,
                threadId,
                message: accepted.message,
              };
              return accepted.message.steered
                ? { ...canonical, steered: true as const }
                : canonical;
            }
            const queued = queuedSteeredMessage(bot.id, threadId, sendId);
            if (queued) {
              if (queued.text !== text || queued.replyToId !== replyTo?.id) {
                throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
              }
              return { ok: true as const, queued: true as const, queueId: queued.id, threadId, reason: queued.reason };
            }
          }

          const currentAtStart = store.projectBotForTask(bot.id, threadId);
          if (!currentAtStart) throw Object.assign(new Error("no such bot"), { status: 404 });
          if (!store.taskByThread(currentAtStart.id, threadId)) {
            throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
          }

          // Claude can accept the message inside its live turn. If the write
          // loses a race with turn settlement, or the engine cannot steer, the
          // existing server-side queue records it atomically for the next turn.
          if (currentAtStart.busy) {
            const instance = runningTurnInstance(currentAtStart, threadId);
            let steered: SteerOutcome = "refused";
            // A live text steer has no image side channel. Keep an attachment
            // message intact for the next ordinary turn, where central image
            // admission can hand it to the provider natively.
            const carriesImages = extractTurnImages(text).images.length > 0;
            const steerTarget = handoffs.current(threadId);
            if (!carriesImages && !computerSelectionTurns.get(threadId)?.selected && instance?.adapter.capabilities.queueing && instance.adapter.steer) {
              steered = await instance.adapter
                .steer(threadId, promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"))
                .catch((): SteerOutcome => "indeterminate");
            }
            // steer() is awaited adapter work. The turn can settle, the task can
            // switch, or the whole bot can be deleted before its acknowledgement
            // arrives. Re-read every ownership invariant before appending even a
            // successful steer; otherwise that late acknowledgement writes a user
            // message into a task the bot no longer owns. A conflict leaves the
            // text in the client's composer/outbox to resend deliberately.
            const current = store.projectBotForTask(bot.id, threadId);
            if (!current) throw Object.assign(new Error("no such bot"), { status: 404 });
            if (!store.taskByThread(bot.id, threadId)) {
              throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
            }
            const delivered = steered !== "refused";
            if (delivered) {
              if (steered === "steered" && !current.busy) {
                throw Object.assign(
                  new Error("the running turn ended before the steered message could be recorded"),
                  { status: 409 },
                );
              }
              // "indeterminate" falls through to the same record: the words
              // may already be folded into a turn whose acknowledgement was
              // lost, and handing them back for a resend could run them
              // twice. Recording them once is the honest outcome.
              // A person steering a webhook turn is present, and auto mode may
              // follow them again. But this route is also reachable from the
              // bot's own shell on a headless server (loopback is the owner
              // there), and "continue" typed by the turn itself must not be
              // the thing that lifts the block written against it — so only
              // a request that proves a person (a paired session, or the
              // desktop's owner capability, which every mutation there has
              // already shown) clears the mark.
              if (auth.kind === "session" || DESKTOP_MANAGED) clearUnattended(threadId);
              const message = store.appendMessage(threadId, {
                role: "user",
                kind: "text",
                text,
                replyToId: replyTo?.id,
                sendId,
                steered: true,
                sender: messageSender(auth),
              });
              // Offered to the next turn again unless the person stops this one.
              handoffs.steered(threadId, steerTarget, instance?.instanceId, message.id);
              return { ok: true as const, steered: true as const, threadId, message };
            }
            if (!current.busy) {
              return startOrQueueDirectMessage(bot.id, threadId, text, replyTo, sendId, messageSender(auth));
            }
            const queued = queueSteeredMessage(current.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
            });
            return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
          }
          return startOrQueueDirectMessage(bot.id, threadId, text, replyTo, sendId, messageSender(auth));
        },
      );
      try {
        json(res, 202, await receiptPromise);
        return true;
      } catch (error) {
        // The steer-or-queue decision inside the receipt callback can refuse
        // with an HTTP status (a busy thread's queue is bounded): answer it
        // from this route, like the spend-cap check above.
        if (typeof (error as { status?: unknown })?.status === "number") {
          json(res, (error as { status: number }).status, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
        throw error;
      }
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      const queueId = m[2];
      if (!cancelSteeredMessage(bot.id, queueId, bot.threadId)) {
        json(res, 404, { error: "no such queued message" });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }

    // Steer a queued message into the RUNNING turn (no interrupt). Engines
    // without a live steer keep the queue; this never ends the current turn.
    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      noteTurnTrigger(bot.threadId, auth);
      // Lift the whole queue atomically: a settle racing this request can
      // drain it as a follow-up, or this request can steer it into the live
      // turn — never both for the same words.
      const held = holdSteeredQueue(bot.id, bot.threadId, m[2]);
      if (!held) { json(res, 404, { error: "no such queued message" }); return true; }
      // A live steer has no image side channel. Attachment words wait for a
      // real turn where central admission can hand the images to the engine.
      if (held.items.some((item) => extractTurnImages(item.text).images.length > 0)) {
        restoreHeldSteeredQueue(held);
        json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
        return true;
      }
      const currentAtStart = store.projectBotForTask(bot.id, bot.threadId);
      const instance = currentAtStart?.busy ? runningTurnInstance(currentAtStart, bot.threadId) : undefined;
      const prompt = held.items.map((item) => item.prompt).join("\n\n");
      const steerTarget = handoffs.current(bot.threadId);
      let steered: SteerOutcome = "refused";
      if (currentAtStart?.busy && instance?.adapter.capabilities.queueing && instance.adapter.steer) {
        steered = await instance.adapter
          .steer(bot.threadId, prompt)
          .catch((): SteerOutcome => "indeterminate");
      }
      // The steer was awaited adapter work: re-read every ownership
      // invariant before writing anything, exactly like the live-send path.
      const current = store.projectBotForTask(bot.id, bot.threadId);
      // "indeterminate" never restores: the words may already be folded into
      // the turn that was live when they were sent, and replaying them into
      // a fresh follow-up turn would run them twice. Record them whenever
      // the destination still exists, busy or not.
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
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          steered: true,
        }));
        // Offered to the next turn again unless the person stops this one.
        for (const message of messages) handoffs.steered(bot.threadId, steerTarget, instance?.instanceId, message.id);
        const queueIds = held.items.map((item) => item.messageId);
        settleHeldSteeredQueue(held);
        json(res, 200, { ok: true, steered: true, threadId: bot.threadId, messages, queueIds });
        return true;
      }
      if (steered === "indeterminate") {
        // No destination is left: settle so a restart cannot replay words a
        // dead turn may already have run.
        settleHeldSteeredQueue(held);
        if (!store.taskByThread(bot.id, bot.threadId)) {
          throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
        }
        throw Object.assign(new Error("no such bot"), { status: 404 });
      }
      restoreHeldSteeredQueue(held);
      // The turn may have settled while the steer was refused; a queue that
      // is now drainable must not strand behind a missed settle.
      if (current && !current.busy) drainQueuedSends();
      json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
      return true;
    }

    // edit a user message → fork the conversation there and rerun the turn.
    // Rewinding a live thread is refused, exactly like switching versions
    // below: interrupting mid-flight and branching under the dying turn is
    // how a conversation ends up with two tails. Stop, then edit.
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      const text = String(body.text ?? "").trim();
      if (!text) { json(res, 400, { error: "text required" }); return true; }
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn flips busy before the
      // next request is handled
      if (threadBusy(bot.id, bot.threadId)) { json(res, 409, { error: "the thread is working — stop it before editing" }); return true; }
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
        return true;
      }
      const source = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        json(res, 404, { error: "only user messages can be edited" });
        return true;
      }
      if (!registry.get(bot.modelSelection.instanceId)) {
        json(res, 409, {
          error: `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
        });
        return true;
      }
      // startTurn admits the rerun before branching. A shared-resource or
      // concurrency-limit refusal must leave the original transcript intact.
      const replyTo = source.replyToId ? resolveReplyTarget(bot.threadId, source.replyToId) : undefined;
      const message = await startTurn(bot.id, text, { threadId: bot.threadId, editedMessageId: messageId, replyTo });
      json(res, 202, { ok: true, message });
      return true;
    }

    // switch which fork of the conversation is visible (no new turn)
    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      if (threadBusy(bot.id, bot.threadId)) { json(res, 409, { error: "the thread is working — stop it before switching versions" }); return true; }
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
        return true;
      }
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) { json(res, 404, { error: "no such message" }); return true; }
      // provider sessions still hold the other branch — next turn replays
      store.patchTask(bot.id, bot.threadId, { rewound: true });
      json(res, 200, { activeLeafId: leaf });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const selected = requestedTaskBot(m[1], body.threadId);
      const bot = botForThread(selected.id, selected.threadId)!;
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) { json(res, 400, { error: "behavior must be allow, deny, or answer" }); return true; }
      if (await resolveAndSendTeamSetup(res, {
        botId: bot.id, threadId: bot.threadId, requestId: String(body.requestId), behavior,
      }, auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return true;
      if (resolveAndSendRoutine(res, {
        botId: bot.id,
        botName: bot.name,
        threadId: bot.threadId,
        requestId: String(body.requestId),
        behavior,
      })) return true;
      if (resolveAndSendProfile(res, {
        botId: bot.id,
        botName: bot.name,
        threadId: bot.threadId,
        requestId: String(body.requestId),
        behavior,
      })) return true;
      if (sendSkillResolution(res, resolveSkillRequest({
        botId: bot.id,
        botName: bot.name,
        threadId: bot.threadId,
        requestId: String(body.requestId),
        behavior,
        reviewedSha256,
      }))) return true;
      // peer-approval intercept: harness-native cards carry a requestId
      // that lives in peer-approval's pending map. Resolve them here so
      // the provider adapter never sees a request it didn't raise.
      if (store.messagesFor(bot.threadId).some((message) => message.card?.requestId === String(body.requestId)) &&
        resolvePeerComms(approvalBus, String(body.requestId), behavior)) {
        json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
        return true;
      }
      const outcome = await answerRequest(bot.threadId, bot.modelSelection.instanceId, String(body.requestId), behavior, body.message, { id: bot.id, name: bot.name }, body.always === true);
      json(res, 200, { ok: true, outcome });
      return true;
    }
    // Answer by THREAD, so a request raised inside a room can be answered
    // too: a member's turn runs on the room's thread, and the bot that
    // owns the pending request is the one currently speaking there.
    m = path.match(/^\/api\/threads\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const threadId = m[1];
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) { json(res, 400, { error: "behavior must be allow, deny, or answer" }); return true; }
      const requestId = String(body.requestId);
      const skillCard = store.messagesFor(threadId).find(
        (message) => message.card?.requestId === requestId && message.card.skillRequest,
      );
      if (skillCard?.card?.skillRequest) {
        const skillBotId = skillCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!skillBotId) { json(res, 400, { error: "this skill request has no valid owner" }); return true; }
        const skillOwner = store.bot(skillBotId);
        if (sendSkillResolution(res, resolveSkillRequest({
          botId: skillBotId,
          botName: skillOwner?.name,
          threadId,
          requestId,
          behavior,
          reviewedSha256,
        }))) return true;
      }
      const routineCard = store.messagesFor(threadId).find(
        (message) => message.card?.requestId === requestId && message.card.routineRequest,
      );
      if (routineCard?.card?.routineRequest) {
        // Derive the owner from the conversation, not from the executable
        // payload being authorized. Room cards carry their trusted sender;
        // one-to-one tasks resolve through the store's thread ownership.
        const routineBotId = routineCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!routineBotId) { json(res, 400, { error: "this routine request has no valid owner" }); return true; }
        const routineOwner = store.bot(routineBotId);
        if (resolveAndSendRoutine(res, {
          botId: routineBotId,
          botName: routineOwner?.name,
          threadId,
          requestId,
          behavior,
        })) return true;
      }
      const setupCard = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.teamSetupRequest);
      if (setupCard) {
        const setupBotId = setupCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!setupBotId) { json(res, 400, { error: "This team setup has no valid owner" }); return true; }
        if (await resolveAndSendTeamSetup(res, { botId: setupBotId, threadId, requestId, behavior },
          auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return true;
      }
      const profileCard = store.messagesFor(threadId).find(
        (message) => message.card?.requestId === requestId && message.card.profileRequest,
      );
      if (profileCard?.card?.profileRequest) {
        const profileBotId = profileCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!profileBotId) { json(res, 400, { error: "this profile request has no valid owner" }); return true; }
        const profileOwner = store.bot(profileBotId);
        if (resolveAndSendProfile(res, {
          botId: profileBotId,
          botName: profileOwner?.name,
          threadId,
          requestId,
          behavior,
        })) return true;
      }
      // peer-approval intercept (see /api/bots/:id/respond above). A peer card
      // belongs to the bus rather than to a speaker, so resolve it before we go
      // looking for one — a room between turns has no speaker to find.
      if (store.messagesFor(threadId).some((message) => message.card?.requestId === requestId) &&
        resolvePeerComms(approvalBus, requestId, behavior)) {
        json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
        return true;
      }
      const group = store.groupByThread(threadId);
      // busyBotId is in-memory only, so an approval that outlives its turn — or
      // the process — leaves a durable card with no speaker behind it. Fall back
      // to the member that raised it, and answer even when that member is gone:
      // answerRequest closes an unreachable card, and a pending approval owns
      // the composer, so a dead end here locks the room for good.
      const pending = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
      const owner = group
        ? (group.busyBotId ? store.bot(group.busyBotId) : undefined) ??
          (pending?.from ? store.bot(pending.from.botId) : undefined)
        : store.botByThread(threadId);
      if (!owner && !pending) { json(res, 404, { error: "nothing is waiting on an answer in this conversation" }); return true; }
      const requestOwner = owner ? botForThread(owner.id, threadId) : null;
      const outcome = await answerRequest(threadId, requestOwner?.modelSelection.instanceId ?? "", requestId, behavior, body.message, owner ? { id: owner.id, name: owner.name } : undefined, body.always === true);
      json(res, 200, { ok: true, outcome });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const body = rawBody ?? {};
      requirePinnedClientThread(bot.id, body.threadId);
      const expectedThreadId = body.threadId;
      if (expectedThreadId !== undefined && (typeof expectedThreadId !== "string" || !/^[\w-]+$/.test(expectedThreadId))) {
        json(res, 400, { error: "threadId must be a task id" });
        return true;
      }
      // Explicit thread targets never fall through to another routine or
      // channel just because it belongs to the same bot.
      if (typeof expectedThreadId === "string" && store.taskByThread(bot.id, expectedThreadId)) {
        const routine = routines()!.activeBotRunForBot(bot.id);
        if (routine?.threadId === expectedThreadId) await routines()!.cancelRun(routine.id);
        else {
          handoffs.stoppedByPerson(expectedThreadId);
          await interruptDirectThread(bot.id, expectedThreadId);
        }
        json(res, 200, { ok: true });
        return true;
      }
      const directClaim = directTurnDispatchClaims.get(bot.threadId);
      const routineRun = routines()!.activeBotRunForBot(bot.id);
      if (routineRun) {
        if (expectedThreadId !== undefined && routineRun.threadId !== expectedThreadId) {
          json(res, 409, { error: "this bot is running a routine in another conversation" });
          return true;
        }
        cancelDirectTurnDispatch(bot.id, routineRun.threadId ?? expectedThreadId);
        if (routineRun.threadId) {
          revokeInternalCapabilitiesForThread(routineRun.threadId);
        }
        await routines()!.cancelRun(routineRun.id);
        json(res, 200, { ok: true });
        return true;
      }
      const instance = registry.get((botForThread(bot.id, expectedThreadId ?? bot.threadId) ?? bot).modelSelection.instanceId);
      // a bot busy in a ROOM is running on the room's thread — stopping it
      // from its own chat must reach that turn, not just the 1:1 thread
      const busyGroup = activeGroupTurnForBot(bot.id);
      if (busyGroup) {
        if (expectedThreadId !== undefined && busyGroup.threadId !== expectedThreadId) {
          json(res, 409, { error: `this bot is working in channel ${busyGroup.group.name}` });
          return true;
        }
        cancelGroupTurnOperations(busyGroup.group.id, busyGroup.threadId);
        revokeInternalCapabilitiesForThread(busyGroup.threadId);
        await instance?.adapter.interruptTurn(busyGroup.threadId).catch(() => {});
        closeOpenApprovals(busyGroup.threadId);
        json(res, 200, { ok: true });
        return true;
      }
      if (
        expectedThreadId !== undefined &&
        !busyGroup &&
        bot.threadId !== expectedThreadId &&
        directClaim?.threadId !== expectedThreadId
      ) {
        json(res, 409, { error: "the bot switched tasks before it could be interrupted" });
        return true;
      }
      handoffs.stoppedByPerson(expectedThreadId ?? bot.threadId);
      await interruptDirectThread(bot.id, expectedThreadId ?? bot.threadId);
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  };
}
