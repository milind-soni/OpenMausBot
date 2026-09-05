// The authority chain behind the worker task and computer tools.
//
// The MCP bridge that exposes those tools runs as a separate per-turn process
// with no view of the registry, the approval card, or SSH. It calls the
// harness's loopback endpoint, and the endpoint calls this. Everything that
// decides anything lives here:
//
//   propose   bind task intent to this worker → register it → ask a person →
//             stage → validate → activate. Only then is the worker available
//             within the approved bounds.
//   status    what is approved for this conversation, and for how long
//   run       one command id out of the approved document
//   results   the artefacts that document declared, and nothing else
//
// A restart forgets every approval on purpose: `WorkerTaskRegistry` keeps them
// in memory, and so does the activation record below. A manifest survives as
// data; permission to execute it does not.
import { z } from "zod";

import type { ResolvedWorker } from "./computer-workers.ts";
import { type JsonValue, parseJson, schemaIssue } from "./schema.ts";
import type { BotRecord } from "./store.ts";
import type { RemoteWorkerSshRunner } from "./remote-worker.ts";
import { defaultRemoteWorkerRunner } from "./remote-worker.ts";
import {
  WORKER_TASK_MAX_REPLY_CONTENT_BLOCKS,
  WORKER_TASK_MAX_REPLY_IMAGE_CHARS,
  WORKER_TASK_MAX_REPLY_TEXT_CHARS,
} from "./worker-task-client.ts";
import {
  cancelWorkerTaskApproval,
  requestWorkerTaskApproval,
  type WorkerApprovalBus,
} from "./worker-task-approval.ts";
import {
  parseWorkerTaskProposal,
  workerTaskManifestDigest,
  type WorkerTaskManifest,
  WorkerTaskRegistry,
} from "./worker-task-manifest.ts";
import {
  activateWorkerTask,
  callWorkerComputerTool,
  defaultWorkerTaskStreamRunner,
  describeWorkerComputerTool,
  fetchWorkerResults,
  resetWorkerTask,
  runWorkerCommand,
  stageWorkerTask,
  validateWorkerTask,
  type WorkerTaskStreamRunner,
  type WorkerResultArtefact,
} from "./worker-task-transport.ts";
import {
  workerCuaCapabilityDigest,
  workerCuaCapabilityManifest,
  workerCuaToolsForSurface,
} from "./worker-cua-capability.ts";

/** Per artefact, so a large diff cannot flood a turn's context. */
const MAX_ARTEFACT_CHARS = 64 * 1024;

function assertTaskAdmission(manifest: WorkerTaskManifest): void {
  // Live acceptance of the pinned Windows driver failed its application deny
  // test. Do not mint desktop authority until a replacement passes that test.
  if (manifest.platform === "windows" && manifest.surface === "desktop") {
    throw new Error("Windows desktop tasks are unavailable: CUA 0.20.0 failed application-boundary acceptance");
  }
}

const requestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("propose"), manifest: z.json() }),
  z.object({ op: z.literal("status") }),
  z.object({ op: z.literal("run"), commandId: z.string().max(128) }),
  z.object({ op: z.literal("results") }),
  z.object({ op: z.literal("describe"), tool: z.string().max(128) }),
  z.object({
    op: z.literal("computer"),
    tool: z.string().max(128),
    arguments: z.record(z.string(), z.json()),
  }),
]);

/** What activation produced, kept beside the registry's approval. Memory only,
 * for the same reason: a restart must not leave a worker looking unlocked. */
interface Activation {
  workerId: string;
  taskRoot: string;
  capabilitySha256: string;
}

export interface WorkerTaskServiceDeps {
  bus: WorkerApprovalBus;
  registry: WorkerTaskRegistry;
  /** The worker this bot is assigned to, or null when it has none. */
  workerFor: (bot: BotRecord) => ResolvedWorker | null;
  /** The exact daemon channel proved ready for this active conversation. */
  channelFor?: (threadId: string) => string | null;
  /** Server-side backstop for the human control hold. The MCP process checks
   * too, but a Full provider may inspect its own child environment and must
   * not be able to bypass the hold by calling the loopback endpoint itself. */
  controlHeld?: (botId: string) => boolean;
  runner?: RemoteWorkerSshRunner;
  streamRunner?: WorkerTaskStreamRunner;
  now?: () => number;
}

/** One task whose approval is live right now, re-checked at the moment of use. */
interface ApprovedTask {
  manifest: WorkerTaskManifest;
  digest: string;
}

export interface WorkerTaskOutcome {
  status: number;
  text?: string;
  content?: WorkerToolContent[];
  isError?: boolean;
  error?: string;
}

export type WorkerToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Convert the one-shot CLI's MCP result back into MCP content while bounding
 * every untrusted field. Older driver builds may return a raw JSON value; in
 * that case it remains useful as text but cannot smuggle an arbitrary block. */
export function workerComputerContent(stdout: Buffer): { content: WorkerToolContent[]; isError: boolean } {
  const raw = stdout.toString("utf8").trim();
  if (!raw) throw new Error("CUA Driver returned no tool result");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    if (start >= 0) {
      try { parsed = JSON.parse(raw.slice(start)); } catch { /* render bounded text below */ }
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const content: WorkerToolContent[] = [];
      for (const block of record.content) {
        if (content.length >= WORKER_TASK_MAX_REPLY_CONTENT_BLOCKS) break;
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        const value = block as Record<string, unknown>;
        if (value.type === "text" && typeof value.text === "string") {
          content.push({ type: "text", text: value.text.slice(0, WORKER_TASK_MAX_REPLY_TEXT_CHARS) });
        } else if (
          value.type === "image" &&
          typeof value.data === "string" &&
          value.data.length <= WORKER_TASK_MAX_REPLY_IMAGE_CHARS &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
        ) {
          const mime = typeof value.mimeType === "string" ? value.mimeType : value.mime_type;
          if (typeof mime === "string" && /^image\/[a-z0-9.+-]+$/i.test(mime)) {
            content.push({ type: "image", data: value.data, mimeType: mime });
          }
        }
      }
      if (content.length > 0) return { content, isError: record.isError === true };
    }
    const screenshot = record.screenshot_png_b64;
    if (
      typeof screenshot === "string" &&
      screenshot.length <= WORKER_TASK_MAX_REPLY_IMAGE_CHARS &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(screenshot)
    ) {
      const withoutImage = { ...record, screenshot_png_b64: `[image data: ${screenshot.length} base64 chars]` };
      return {
        content: [
          { type: "text", text: JSON.stringify(withoutImage).slice(0, WORKER_TASK_MAX_REPLY_TEXT_CHARS) },
          { type: "image", data: screenshot, mimeType: "image/png" },
        ],
        isError: false,
      };
    }
  }
  return {
    content: [{ type: "text", text: raw.slice(0, WORKER_TASK_MAX_REPLY_TEXT_CHARS) }],
    isError: false,
  };
}

/** Render bounded result previews without ever creating a multi-megabyte
 * intermediate string that the loopback client will reject. */
export function workerResultsText(artefacts: WorkerResultArtefact[]): string {
  let output = "";
  for (const artefact of artefacts) {
    const resultText = artefact.content.toString("utf8");
    const shown = artefact.truncated || resultText.length > MAX_ARTEFACT_CHARS
      ? `${resultText.slice(0, MAX_ARTEFACT_CHARS)}\n… truncated at ${MAX_ARTEFACT_CHARS} characters`
      : resultText;
    const separator = output.length === 0 ? "" : "\n\n";
    const section = `── ${artefact.path} (${artefact.bytes} bytes)\n${shown}`;
    const addition = `${separator}${section}`;
    if (output.length + addition.length > WORKER_TASK_MAX_REPLY_TEXT_CHARS) {
      const suffix = "\n… truncated: request fewer result paths";
      return `${output}${addition}`.slice(0, WORKER_TASK_MAX_REPLY_TEXT_CHARS - suffix.length) + suffix;
    }
    output += addition;
  }
  return output;
}

export class WorkerTaskService {
  private readonly activations = new Map<string, Activation>();
  private readonly deps: WorkerTaskServiceDeps;

  // Assigned in the body rather than declared as a constructor parameter
  // property: the packaged server runs under Node's strip-only TypeScript mode,
  // which rejects `constructor(private readonly x: T)` outright. `tsc` and
  // vitest both transpile, so neither notices — only booting the real server
  // does.
  constructor(deps: WorkerTaskServiceDeps) {
    this.deps = deps;
  }

  private get runner(): RemoteWorkerSshRunner {
    return this.deps.runner ?? defaultRemoteWorkerRunner;
  }

  private get streamRunner(): WorkerTaskStreamRunner {
    return this.deps.streamRunner ?? defaultWorkerTaskStreamRunner;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Forget one worker's activations without touching the other's. Paired with
   * `WorkerTaskRegistry.revokeWorker` for #508 item 6. */
  forgetWorker(workerId: string): void {
    for (const record of this.deps.registry.forWorker(workerId)) {
      this.activations.delete(record.manifest.taskId);
      cancelWorkerTaskApproval(record.manifest.taskId);
    }
    this.deps.registry.revokeWorker(workerId);
  }

  async handle(bot: BotRecord, body: JsonValue, threadId = bot.threadId): Promise<WorkerTaskOutcome> {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, error: schemaIssue(parsed.error, "unknown worker task operation") };
    }
    const worker = this.deps.workerFor(bot);
    if (!worker) return { status: 409, error: "this bot is not assigned to a configured worker" };
    if (this.deps.controlHeld?.(bot.id)) {
      return { status: 409, error: "You have control of this computer right now. The bot's computer actions are paused." };
    }

    try {
      switch (parsed.data.op) {
        case "propose":
          return await this.propose(bot, worker, threadId, parsed.data.manifest);
        case "status":
          return this.status(worker, threadId);
        case "run":
          return await this.run(worker, threadId, parsed.data.commandId);
        case "results":
          return await this.results(worker, threadId);
        case "describe":
          return await this.describe(worker, threadId, parsed.data.tool);
        case "computer":
          return await this.computer(worker, threadId, parsed.data.tool, parsed.data.arguments);
      }
    } catch (error) {
      // A failed task is a normal outcome for the model to read and react to,
      // not a transport fault: 200 with an explanatory body would hide it, and
      // a 500 would read as "OpenMausBot broke". 409 says "this did not run".
      return { status: 409, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async propose(
    bot: BotRecord,
    worker: ResolvedWorker,
    threadId: string,
    raw: JsonValue,
  ): Promise<WorkerTaskOutcome> {
    if (!bot.cwd) {
      return {
        status: 409,
        error:
          "this bot has no working folder, so there is nothing to stage — " +
          "set one in the bot's settings before proposing a worker task",
      };
    }
    // Re-serialized and re-parsed so `parseWorkerTaskProposal` sees a plain JSON
    // value and never a live object carrying getters or a prototype.
    const document: JsonValue = parseJson(JSON.stringify(raw ?? null));
    const manifest = parseWorkerTaskProposal(document, worker, threadId, this.now());
    assertTaskAdmission(manifest);
    const digest = workerTaskManifestDigest(manifest);
    this.deps.registry.register(manifest);

    const verdict = await requestWorkerTaskApproval(this.deps.bus, worker, manifest, digest, threadId);
    if (verdict !== "allow") {
      return { status: 200, text: "The person denied this task. Nothing was staged, activated or run." };
    }
    if (!this.deps.registry.approve(manifest.taskId, digest, this.now())) {
      throw new Error("the task expired before it was approved");
    }

    let touchedWorker = false;
    try {
      touchedWorker = true;
      await stageWorkerTask(worker, bot.cwd, manifest, this.streamRunner);
      const validated = await validateWorkerTask(worker, manifest, digest, this.runner);
      const issuedAt = this.now();
      // Publish the one digest the readiness probe may accept before asking
      // the daemon to load it. This closes the activation race without ever
      // accepting an arbitrary well-formed digest from the worker.
      const expectedCapability = workerCuaCapabilityDigest(
        workerCuaCapabilityManifest(manifest, validated.taskRoot, issuedAt),
      );
      this.activations.set(manifest.taskId, {
        workerId: worker.id,
        taskRoot: validated.taskRoot,
        capabilitySha256: expectedCapability,
      });
      const activated = await activateWorkerTask(
        worker,
        manifest,
        digest,
        validated.taskRoot,
        this.runner,
        issuedAt,
      );
      this.activations.set(manifest.taskId, {
        workerId: worker.id,
        taskRoot: validated.taskRoot,
        capabilitySha256: activated.capabilitySha256,
      });

      return {
        status: 200,
        text: [
          `Approved and active on ${worker.displayName}.`,
          `Task ${manifest.taskId} · manifest ${digest.slice(0, 12)} · capability ${activated.capabilitySha256.slice(0, 12)}`,
          `Staged ${validated.files} files. Commands you may run: ${validated.commandIds.join(", ")}.`,
          `The ${manifest.surface} capability is now live; it expires at ` +
            `${new Date(manifest.expiresAt).toISOString()} or after ${
              Math.round(manifest.idleTimeoutMs / 60_000)
            } idle minutes, whichever comes first.`,
        ].join("\n"),
      };
    } catch (error) {
      this.activations.delete(manifest.taskId);
      this.deps.registry.revoke(manifest.taskId);
      cancelWorkerTaskApproval(manifest.taskId);
      if (touchedWorker) {
        try {
          await resetWorkerTask(worker, manifest.taskId, this.runner);
        } catch {
          // Local authority is already gone. The remote capability has its
          // own idle/expiry fence if the best-effort reset cannot reach it.
        }
      }
      throw error;
    }
  }

  /** The current task and its live approval, or an explanation of why there is
   * none. Never mints an approval as a side effect of being asked. */
  private status(worker: ResolvedWorker, threadId: string): WorkerTaskOutcome {
    const record = this.deps.registry.forThread(threadId);
    if (!record) return { status: 200, text: "No worker task has been proposed in this conversation." };
    const live = this.deps.registry.approved(record.manifest.taskId, record.digest, this.now());
    if (!live) {
      return {
        status: 200,
        text:
          `Task ${record.manifest.taskId} is no longer approved — it expired, idled out, or the worker went offline. ` +
          "Propose it again to run anything.",
      };
    }
    if (record.manifest.workerId !== worker.id) {
      return { status: 409, error: "this task was approved for a different worker" };
    }
    const activation = this.activations.get(record.manifest.taskId);
    const remaining = Math.max(0, Math.round((live.manifest.expiresAt - this.now()) / 60_000));
    return {
      status: 200,
      text: [
        `Task ${live.manifest.taskId} · manifest ${live.digest.slice(0, 12)} · ${live.manifest.surface}`,
        `Capability ${activation?.capabilitySha256.slice(0, 12) ?? "not activated"} · about ${remaining} min left`,
        `Commands: ${live.manifest.commands.map((command) => command.id).join(", ")}`,
      ].join("\n"),
    };
  }

  /** Every call re-checks the approval rather than trusting the one taken at
   * propose time: the idle fence only means something if it is read again. */
  private approvedFor(worker: ResolvedWorker, threadId: string): ApprovedTask {
    const record = this.deps.registry.forThread(threadId);
    if (!record) throw new Error("no worker task has been proposed in this conversation");
    if (record.manifest.workerId !== worker.id) throw new Error("this task was approved for a different worker");
    assertTaskAdmission(record.manifest);
    const live = this.deps.registry.approved(record.manifest.taskId, record.digest, this.now());
    if (!live) throw new Error("this task is no longer approved — propose it again");
    const activation = this.activations.get(live.manifest.taskId);
    if (!activation || activation.workerId !== worker.id) {
      throw new Error("this task was never activated on this worker");
    }
    return { manifest: live.manifest, digest: live.digest };
  }

  private async run(worker: ResolvedWorker, threadId: string, commandId: string): Promise<WorkerTaskOutcome> {
    const { manifest, digest } = this.approvedFor(worker, threadId);
    const result = await runWorkerCommand(worker, manifest, digest, commandId, this.runner);
    const body = [
      `${commandId} exited ${result.code ?? "without a status"}`,
      result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
      result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
    ].filter(Boolean);
    return { status: 200, text: body.join("\n\n") };
  }

  private async results(worker: ResolvedWorker, threadId: string): Promise<WorkerTaskOutcome> {
    const { manifest, digest } = this.approvedFor(worker, threadId);
    const artefacts = await fetchWorkerResults(worker, manifest, digest, this.streamRunner);
    if (artefacts.length === 0) {
      return { status: 200, text: "The task has not produced any of its declared result artefacts yet." };
    }
    return { status: 200, text: workerResultsText(artefacts) };
  }

  private allowedComputerTool(manifest: WorkerTaskManifest, tool: string): void {
    if (!workerCuaToolsForSurface(manifest.surface).includes(tool)) {
      throw new Error(`the approved ${manifest.surface} task does not allow the ${tool} computer tool`);
    }
  }

  private async describe(worker: ResolvedWorker, threadId: string, tool: string): Promise<WorkerTaskOutcome> {
    const { manifest } = this.approvedFor(worker, threadId);
    this.allowedComputerTool(manifest, tool);
    return { status: 200, text: await describeWorkerComputerTool(worker, tool, this.runner) };
  }

  private async computer(
    worker: ResolvedWorker,
    threadId: string,
    tool: string,
    args: Record<string, JsonValue>,
  ): Promise<WorkerTaskOutcome> {
    const { manifest } = this.approvedFor(worker, threadId);
    this.allowedComputerTool(manifest, tool);
    const channelPath = this.deps.channelFor?.(threadId) ?? null;
    if (!channelPath) throw new Error("this worker conversation has no verified CUA channel");
    // One-shot CLI processes need a stable public session label for window
    // handles, browser targets, element indices, and lifecycle state to span
    // calls. Override any model-supplied label with the approved task id.
    const result = await callWorkerComputerTool(
      worker,
      channelPath,
      tool,
      { ...args, session: manifest.taskId },
      this.streamRunner,
    );
    const parsed = workerComputerContent(result.stdout);
    return { status: 200, ...parsed };
  }

  /** Wipe a task off its worker and put the worker back on its non-action
   * capability. Best effort by design: it runs on teardown paths where the
   * worker may already be unreachable, and a failure there must not stop the
   * local state from being dropped. */
  async release(worker: ResolvedWorker, taskId: string): Promise<void> {
    this.activations.delete(taskId);
    this.deps.registry.revoke(taskId);
    cancelWorkerTaskApproval(taskId);
    try {
      await resetWorkerTask(worker, taskId, this.runner);
    } catch {
      // Unreachable worker: the approval is already gone locally, and the
      // worker's own idle timeout expires the capability on its side.
    }
  }

  /** The only non-parked capability digest a readiness probe may accept for
   * this worker. Returns null when no approved activation is live. */
  activeCapabilityDigest(workerId: string): string | null {
    for (const record of this.deps.registry.forWorker(workerId)) {
      const now = this.now();
      const live = record.approvedAt !== null
        && record.lastUsedAt !== null
        && record.manifest.expiresAt > now
        && now - record.lastUsedAt < record.manifest.idleTimeoutMs;
      const activation = this.activations.get(record.manifest.taskId);
      if (live && activation?.workerId === workerId) return activation.capabilitySha256;
    }
    return null;
  }
}
