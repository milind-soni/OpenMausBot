// Harness-native approval for one remote worker task.
//
// This is the only human gate on the whole worker path, and it is worth being
// explicit about why. A worker's CUA bridge mounts with
// `scope: "remote-worker-computer"`, which `drivers/claude.ts` treats as "not
// the user's own screen" and therefore pre-allows — so a worker tool call never
// reaches the provider's permission broker. Containment comes from the three
// fences instead: the base policy on the worker, the derived CUA capability,
// and this card over the task manifest's digest.
//
// Mechanically it rides the same options-card flow as peer-approval.ts: a card
// with a harness-owned `requestId`, intercepted by the respond endpoints before
// the provider adapter ever sees it. Two things differ, both deliberate:
//
//   * There is no "Always allow". A remembered grant cannot describe a task
//     whose whole identity is a digest that changes with every document, and
//     `autoVerdict` already refuses to let a grant answer a scoped desktop
//     request. The card offers Allow and Deny, and nothing else.
//   * The card never names the SSH alias. #508 item 7 keeps the transport
//     identity out of anything a bot, a device client, or an export can read.
import { newId } from "./contracts.ts";
import { publicWorker, type ResolvedWorker } from "./computer-workers.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import type { Message } from "./store.ts";
import type { WorkerTaskManifest } from "./worker-task-manifest.ts";

/** Exactly what peer-approval.ts needs, because it is the same object: index.ts
 * builds one `approvalBus` and hands it to both. Re-exported under this name so
 * a reader of this file does not have to go looking for the shape. */
export type WorkerApprovalBus = ApprovalBus;

/** Long enough for a person to actually read a command list, short enough that
 * an unattended task cannot hold a worker's lease all day. Matches the peer
 * approval and Claude broker timeouts. */
export const WORKER_TASK_APPROVAL_TIMEOUT_MS = 15 * 60_000;

interface Pending {
  resolve: (result: "allow" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
  workerId: string;
  taskId: string;
  threadId: string;
  messageId: string;
  bus: WorkerApprovalBus;
}

/** requestId → pending approval. Memory only: a restart denies every in-flight
 * task, which is the same posture `WorkerTaskRegistry` takes on its approvals. */
const pendingTasks = new Map<string, Pending>();

function humanBytes(total: number): string {
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${Math.round(total / 1024)} KB`;
  return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

/** The whole of what a person is agreeing to, in the order they need it:
 * which machine, what surface, what will actually execute, and how long the
 * approval lives. Built from `publicWorker`, so the alias cannot leak into a
 * card, a transcript, or an export. */
export function describeWorkerTask(worker: ResolvedWorker, manifest: WorkerTaskManifest): string {
  const shown = publicWorker(worker);
  const os = shown.platform === "windows" ? "Windows" : "macOS";
  const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const lines = [
    `${shown.displayName} (${os}) · ${manifest.surface} · ${manifest.files.length} files, ${humanBytes(bytes)}`,
    "",
    ...manifest.commands.map((command) => `• ${[command.executable, ...command.argv].join(" ")}`),
  ];
  if (manifest.origins.length > 0) {
    lines.push("", `Browser origins: ${manifest.origins.join(", ")}`);
  }
  lines.push(
    "",
    `Expires ${new Date(manifest.expiresAt).toLocaleTimeString()} · idles out after ${
      Math.round(manifest.idleTimeoutMs / 60_000)
    } min`,
  );
  return lines.join("\n");
}

function pushApprovalCard(
  bus: WorkerApprovalBus,
  worker: ResolvedWorker,
  manifest: WorkerTaskManifest,
  digest: string,
  requestId: string,
  threadId: string,
): Message {
  return bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `Run a task on ${worker.displayName}`,
      subtitle: describeWorkerTask(worker, manifest),
      options: ["Allow", "Deny"],
      requestId,
      // The digest is the identity of what was approved. Naming it as the tool
      // puts it in the transcript and in the decision log, so an audit can tie
      // a click to the exact document that ran.
      tool: `worker_task:${digest.slice(0, 12)}`,
      // Deliberately no allowKey: see the header.
      approvalScope: "remote-worker-computer",
    },
  });
}

/** Ask the person whether this exact document may run on this exact worker.
 * Resolves `"allow"` or `"deny"`; never resolves from a remembered grant. */
export function requestWorkerTaskApproval(
  bus: WorkerApprovalBus,
  worker: ResolvedWorker,
  manifest: WorkerTaskManifest,
  digest: string,
  threadId: string,
): Promise<"allow" | "deny"> {
  return new Promise((resolve) => {
    const requestId = newId();
    // The card exists before the entry, so a timeout or an answer can always
    // find it to settle.
    const card = pushApprovalCard(bus, worker, manifest, digest, requestId, threadId);
    const timer = setTimeout(() => {
      const pending = pendingTasks.get(requestId);
      if (!pending) return;
      pendingTasks.delete(requestId);
      settleCard(pending, "deny", "system");
      resolve("deny");
    }, WORKER_TASK_APPROVAL_TIMEOUT_MS);
    timer.unref?.(); // a waiting card must never hold the process open
    pendingTasks.set(requestId, {
      resolve,
      timer,
      workerId: worker.id,
      taskId: manifest.taskId,
      threadId,
      messageId: card.id,
      bus,
    });
  });
}

/** Mark the card answered so the UI stops treating it as pending. A
 * harness-native card emits no `request.resolved`, so it settles itself. */
function settleCard(pending: Pending, behavior: string, source: "user" | "system"): void {
  const existing = pending.bus.store
    .messagesFor(pending.threadId)
    .find((message) => message.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
  });
}

/** Called by the respond endpoints BEFORE forwarding to the provider adapter.
 * True means the requestId was a worker task and has now been settled. */
export function resolveWorkerTaskApproval(requestId: string, behavior: string | undefined): boolean {
  const pending = pendingTasks.get(requestId);
  if (!pending) return false;
  pendingTasks.delete(requestId);
  clearTimeout(pending.timer);
  const allow = behavior === "allow";
  settleCard(pending, allow ? "allow" : "deny", "user");
  pending.resolve(allow ? "allow" : "deny");
  return true;
}

function cancelWhere(match: (pending: Pending) => boolean): number {
  let cancelled = 0;
  for (const [requestId, pending] of pendingTasks) {
    if (!match(pending)) continue;
    pendingTasks.delete(requestId);
    clearTimeout(pending.timer);
    settleCard(pending, "deny", "system");
    pending.resolve("deny");
    cancelled += 1;
  }
  return cancelled;
}

/** One worker going offline denies only its own pending tasks. #508 item 6:
 * the other worker's desktop stays usable, and its approvals stay valid. */
export function cancelWorkerTaskApprovalsForWorker(workerId: string): number {
  return cancelWhere((pending) => pending.workerId === workerId);
}

/** An interrupted turn must not leave its task waiting out the full timeout. */
export function cancelWorkerTaskApprovalsForThread(threadId: string): number {
  return cancelWhere((pending) => pending.threadId === threadId);
}

export function cancelWorkerTaskApproval(taskId: string): number {
  return cancelWhere((pending) => pending.taskId === taskId);
}

/** Cards left on disk by a previous run can never be answered — the promise
 * they belonged to died with the process. Settle them at boot so a crashed run
 * does not leave a thread with a permanently blocked composer. */
export function dismissStaleWorkerTaskCards(bus: WorkerApprovalBus): number {
  let dismissed = 0;
  for (const bot of bus.store.bots) {
    const threadIds = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
    for (const threadId of threadIds) {
      for (const message of bus.store.messagesFor(threadId)) {
        const card = message.card;
        if (!card?.requestId || card.answered || card.dismissed) continue;
        if (!card.tool?.startsWith("worker_task:")) continue;
        if (pendingTasks.has(card.requestId)) continue;
        // Boot-time, before any client is connected, so this counts rather
        // than broadcasting — the same as dismissStalePeerCards.
        if (bus.store.patchMessage(threadId, message.id, { card: { ...card, answered: "deny", dismissed: true } })) {
          dismissed += 1;
        }
      }
    }
  }
  return dismissed;
}
