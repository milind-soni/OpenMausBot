// The boot tail -- calendar starts, edition/brand resolution, workspace
// access wiring with its revalidation timer, stale upload-partial and
// thread-log recovery, the follow-up boot drain, steered/channel message
// restore, the loopback listen with its delegation drain, the optional
// tunnel listener, and graceful-shutdown registration -- extracted verbatim
// from index.ts's module tail. index.ts calls `await runBootSequence(...)`
// at exactly the line where `calendarCalls!.start();` used to sit, so
// initialization order and every downstream consumer are unchanged.
// TUNNEL_SOCKET and tunnelListener move with the module (tunnelListener had
// no reader outside the region); the late-bound lets (routines,
// calendarCalls, webhookIngress) cross as thunks, and the two lets the
// region reassigns (workspaceAccess, companyShutdown) cross as { get, set }
// accessors over index.ts's bindings.
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { cleanupStaleAttachmentPartials } from "./attachments.ts";
import { DATA_DIR, threadEventLogRetentionDays } from "./config.ts";
import { sweepThreadEventLogs, type ThreadLogRetentionCandidate } from "./thread-retention.ts";
import { flushUsageLedger } from "./usage-ledger.ts";
import { chatFollowups, closeMessageDb, settleChatFollowups } from "./message-db.ts";
import { discardDelegations, pendingThreads } from "./delegations.ts";
import { restoreSteeredMessages } from "./steer-queue.ts";
import { restoreChannelMessages } from "./channel-queue.ts";
import { recordHanded } from "./delta-context.ts";
import { flushAllMemoryJournals } from "./memory-journal.ts";
import { flushAllProfileHistory } from "./profile-versions.ts";
import { flushDecisionLog } from "./decision-log.ts";
import * as vps from "./vps-computer.ts";
import { createGracefulShutdown } from "./graceful-shutdown.ts";
import { createWorkspaceAccess, describeEdition, loadEnterpriseLayer, type WorkspaceAccess } from "./enterprise.ts";
import { describeBrand, loadBrand } from "./brand.ts";
import { revokeAllInternalCapabilities } from "./internal-capabilities.ts";
import { cfg, registry, releaseDataDirLeaseAtExit, store } from "./runtime.ts";
import { threadBusy } from "./turn-admission.ts";
import type { WebhookIngress } from "./webhook-ingress.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { RoutineManager } from "./routines.ts";
import type { CalendarCallManager } from "./calendar-calls.ts";
import type { Message } from "./store.ts";
import type { SharedComputers } from "./shared-computers.ts";
import type { ManagedDesktopProviders } from "./managed-desktop.ts";
import type { createTurnIntegrations } from "./turn-integrations.ts";
import type { createComputerLifecycleWiring } from "./computer-lifecycle-wiring.ts";
import type { createRoutineLifecycle } from "./routine-lifecycle.ts";
import type { createTurnDispatch } from "./turn-dispatch.ts";
import type { createGroupState } from "./group-state.ts";
import type { createEventsPipeline } from "./events-pipeline.ts";

type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;
type ComputerLifecycleWiring = ReturnType<typeof createComputerLifecycleWiring>;
type RoutineLifecycle = ReturnType<typeof createRoutineLifecycle>;
type TurnDispatch = ReturnType<typeof createTurnDispatch>;
type GroupState = ReturnType<typeof createGroupState>;
type EventsPipeline = ReturnType<typeof createEventsPipeline>;

/** Everything the boot tail reads from its host. The server and request
 * handler are index.ts's listeners-in-waiting; the managers and the webhook
 * ingress are bound later or reloaded, so they cross as thunks; the two lets
 * the region reassigns cross as { get, set } accessors. */
export interface BootSequenceDeps {
  server: Server<typeof IncomingMessage, typeof ServerResponse>;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => unknown;
  calendarCalls(): CalendarCallManager | null;
  routines(): RoutineManager | null;
  webhookIngress(): WebhookIngress | null;
  workspaceAccess: { get(): WorkspaceAccess | null; set(value: WorkspaceAccess | null): void };
  companyShutdown: { get(): boolean; set(value: boolean): void };
  sessions: SessionRegistry;
  SESSION_COOKIE: string;
  closeSessionStreams: EventsPipeline["closeSessionStreams"];
  PORT: number;
  companyRuntimeReady: () => void;
  followupsReady: ComputerLifecycleWiring["followupsReady"];
  drainQueuedSends: TurnDispatch["drainQueuedSends"];
  drainQueuedChannelSends: GroupState["drainQueuedChannelSends"];
  commsBus: RoutineLifecycle["commsBus"];
  drainThreadDelegations: TurnDispatch["drainThreadDelegations"];
  expireDelegationsNow: TurnDispatch["expireDelegationsNow"];
  DELEGATION_SWEEP_MS: TurnDispatch["DELEGATION_SWEEP_MS"];
  sharedComputers: SharedComputers;
  sharedComputerControl: ComputerLifecycleWiring["sharedComputerControl"];
  browserLive: TurnIntegrations["browserLive"];
  localVmIdles: ComputerLifecycleWiring["localVmIdles"];
  watchdog: EventsPipeline["watchdog"];
  managedDesktop: ManagedDesktopProviders;
  temporaryBrowserSessions: TurnIntegrations["temporaryBrowserSessions"];
  forgetTemporaryBrowser: TurnIntegrations["forgetTemporaryBrowser"];
  browserRuntime: TurnIntegrations["browserRuntime"];
  roomHandoffs: GroupState["roomHandoffs"];
  isContextMessage: (m: Message) => boolean;
}

export async function runBootSequence(deps: BootSequenceDeps): Promise<void> {
  const {
    server,
    handleRequest,
    calendarCalls,
    routines,
    webhookIngress,
    workspaceAccess,
    companyShutdown,
    sessions,
    SESSION_COOKIE,
    closeSessionStreams,
    PORT,
    companyRuntimeReady,
    followupsReady,
    drainQueuedSends,
    drainQueuedChannelSends,
    commsBus,
    drainThreadDelegations,
    expireDelegationsNow,
    DELEGATION_SWEEP_MS,
    sharedComputers,
    sharedComputerControl,
    browserLive,
    localVmIdles,
    watchdog,
    managedDesktop,
    temporaryBrowserSessions,
    forgetTemporaryBrowser,
    browserRuntime,
    roomHandoffs,
    isContextMessage,
  } = deps;

  calendarCalls()!.start();

  // Resolve the edition before accepting requests so /api/edition is never a guess.
  console.log(describeEdition(await loadEnterpriseLayer()));
  workspaceAccess.set(createWorkspaceAccess({ sessions, cookieName: SESSION_COOKIE, closeSessionStreams }));
  // Ten-second cadence plus the bridge's five-second backchannel deadline bounds
  // stale portal access on quiet event/browser streams to fifteen seconds.
  const workspaceAccessTimer = workspaceAccess.get() ? setInterval(() => {
    void workspaceAccess.get()!.revalidate().catch((error) => console.warn("workspace access revalidation failed", error));
  }, 10_000) : null;
  workspaceAccessTimer?.unref();
  console.log(describeBrand(loadBrand()));

  // Reclaim upload partials a previous run crashed out of, and warm the
  // attachment quota cache off the same scan. This used to happen implicitly on
  // every reservation, which is exactly what made uploads quadratic in
  // directory size; do the initial sweep before accepting requests.
  // ponytail: once per boot, not periodic. A partial orphaned while this
  // process is up survives until the next restart — add a timer only if that
  // shows up as real quota pressure.
  try {
    const reclaimedPartials = cleanupStaleAttachmentPartials();
    if (reclaimedPartials > 0) console.log(`reclaimed ${reclaimedPartials} abandoned upload partial(s)`);
  } catch (error) {
    console.warn(`attachments: startup partial cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // #1280: retention for per-thread event logs. Off unless configured, and
  // even then it only removes log files — transcripts, thread records, and
  // workspace state stay untouched. A thread qualifies only when its newest
  // close or archive stamp is older than the window and it is not busy,
  // unread, or carrying an open direct handoff.
  const THREAD_LOG_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

  function sweepThreadEventLogsNow(): void {
    const retentionDays = threadEventLogRetentionDays(cfg);
    if (retentionDays === null) return;
    const candidates: ThreadLogRetentionCandidate[] = store.bots.flatMap((bot) =>
      (bot.tasks ?? []).map((task) => ({
        threadId: task.threadId,
        closedAt: task.closedBy?.at ?? null,
        archivedAt: task.archivedAt ?? null,
        unread: task.unread === true,
        busy: threadBusy(bot.id, task.threadId),
        openDirectHandoff: roomHandoffs.activeDirect(task.threadId),
      })));
    const swept = sweepThreadEventLogs(candidates, retentionDays);
    if (swept > 0) console.log(`[retention] removed event logs for ${swept} idle thread(s) past ${retentionDays} day(s)`);
  }

  try {
    sweepThreadEventLogsNow();
  } catch (error) {
    console.warn(`thread event log retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A days-scale window needs no tighter cadence; unref so the timer never
  // holds the process open.
  setInterval(sweepThreadEventLogsNow, THREAD_LOG_RETENTION_SWEEP_MS).unref();

  // A dispatch claim is deliberately committed before transcript/provider work.
  // If we died after that point, its outcome is unknown: recover the user's words
  // and a review notice, never hand them to a model for a second execution.
  for (const row of chatFollowups()) {
    if (row.status !== "dispatching" && row.status !== "interrupted") continue;
    const owned = row.kind === "bot"
      ? Boolean(store.taskByThread(row.ownerId, row.threadId))
      : Boolean(store.groupByThread(row.threadId)?.id === row.ownerId);
    if (!owned) { settleChatFollowups([row.id], "cancelled"); continue; }
    settleChatFollowups([row.id], "interrupted");
    const messages = store.messagesFor(row.threadId);
    const recovered = messages.find((message) => message.queueId === row.id && message.role === "user") ?? store.appendMessage(row.threadId, {
      role: "user", kind: "text", text: row.payload.text, replyToId: row.payload.replyToId,
      sendId: row.payload.sendId, queueId: row.id,
      ...(row.kind === "channel" ? { channelMode: row.payload.mode, via: row.payload.via } : {}),
    });
    // Nor as a message a resumed session has not seen: count it as handed.
    const recoveredTask = row.kind === "bot" ? store.taskByThread(row.ownerId, row.threadId) : undefined;
    const order = store.activePath(row.threadId).filter(isContextMessage).map((m) => m.id);
    for (const [instanceId, state] of Object.entries(recoveredTask?.handedMessages ?? {})) {
      if (state.session !== undefined) store.setHandedMessages(row.ownerId, row.threadId, instanceId, recordHanded(state, order, [recovered.id]));
    }
    if (!messages.some((message) => message.queueId === row.id && message.kind === "activity")) {
      store.appendMessage(row.threadId, {
        role: "bot", kind: "activity", queueId: row.id,
        tool: { name: "Queued follow-up interrupted by restart or restore — it may have already run. Review the result before sending it again.", ok: false },
      });
    }
    // The FULL-sync retirement also flushes both transcript writes. Retrying
    // this sendId now finds the canonical message, without a permanent journal scan.
    settleChatFollowups([row.id], null);
  }
  restoreSteeredMessages();
  restoreChannelMessages();

  server.listen(PORT, "127.0.0.1", () => {
    companyRuntimeReady();
    console.log(`openmausbot server on http://127.0.0.1:${PORT}`);
    followupsReady.set(true);
    drainQueuedSends();
    drainQueuedChannelSends();
    // Startup work uses the same turn dispatcher and local tool endpoint as
    // ordinary chat. Start only once every registry is initialized and the
    // endpoint is listening; earlier dispatch can hit uninitialized bindings.
    routines()!.start();
    const leftover = pendingThreads();
    if (leftover.length) console.log(`delegations: ${leftover.length} thread(s) with queued handoffs from a previous run — draining`);
    for (const threadId of leftover) {
      const run = routines()!.runForThread(threadId);
      // A person can reuse a completed run's task for unrelated work. Only
      // discard the old run's handoffs, not a later user's persisted queue.
      const reused = run?.finishedAt !== undefined && store.botByThread(threadId) &&
        store.activePath(threadId).some((message) => message.role === "user" && message.at > run.finishedAt!);
      if (run && !["running", "waiting"].includes(run.status) && !reused) discardDelegations(commsBus, threadId);
      else drainThreadDelegations(threadId);
    }
    // After the boot drain, not before it: that drain already expires stale
    // leftovers, and a sweep ahead of it would wake delegators of stopped
    // routine runs whose handoffs the loop above discards instead.
    setInterval(expireDelegationsNow, DELEGATION_SWEEP_MS).unref();
  });

  // A second listener for `openmausbot serve --tunnel` (server/tunnel.ts): the
  // connector gateway on this machine forwards public traffic to this IPC path.
  // Nothing changes about the loopback bind above. Requests arriving here have
  // no peer address, which request-auth treats as "through a proxy": a session
  // is required, never loopback trust, whatever headers the request carries.
  const TUNNEL_SOCKET = process.env.OMB_TUNNEL_SOCKET?.trim() || null;
  let tunnelListener: ReturnType<typeof createServer> | null = null;
  if (TUNNEL_SOCKET) {
    if (process.platform !== "win32") rmSync(TUNNEL_SOCKET, { force: true });
    tunnelListener = createServer(handleRequest);
    tunnelListener.listen(TUNNEL_SOCKET, () => {
      console.log(`openmausbot tunnel listener on ${TUNNEL_SOCKET}`);
    });
  }

  const gracefulShutdown = createGracefulShutdown({
    cleanup: [
      () => {
        followupsReady.set(false);
        companyShutdown.set(true);
        if (workspaceAccessTimer) clearInterval(workspaceAccessTimer);
        // Child MCP processes and the HTTP listener can remain alive while the
        // asynchronous shutdown jobs drain. Invalidate their turn bearers before
        // any cleanup function reaches an await.
        revokeAllInternalCapabilities();
        sharedComputers.close();
        sharedComputerControl.close();
        browserLive.closeAll();
        for (const idle of localVmIdles.values()) idle.cancel();
        vps.closeAllVpsDesktopTunnels();
        watchdog.stop();
        routines()?.stop();
        calendarCalls()?.stop();
        webhookIngress()?.server.close();
        tunnelListener?.close();
      },
      async () => { await managedDesktop.close(); await registry.disposeAll(); },
      async () => {
        await Promise.all([...temporaryBrowserSessions.keys()].map((botId) => forgetTemporaryBrowser(botId)));
        await browserRuntime.closeAll();
      },
      () => flushAllProfileHistory(),
      () => flushAllMemoryJournals(),
      () => flushUsageLedger(DATA_DIR),
      () => flushDecisionLog(DATA_DIR),
    ],
    // Cleanup jobs run concurrently. Release only after they settle (or reach
    // the shutdown deadline), immediately before the process exits, so no new
    // server can overlap with a still-mutating old one.
    exit: (code) => {
      try { sessions.close(); }
      catch {
        // An uncleared marker makes saved account sessions require sign-in on
        // the next boot; never label failed persistence a clean shutdown.
        console.error("Session persistence failed during shutdown; account sign-in will be required again.");
        code = 1;
      }
      closeMessageDb();
      releaseDataDirLeaseAtExit();
      process.exit(code);
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, gracefulShutdown);
  }
}
