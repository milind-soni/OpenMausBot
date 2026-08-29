// The authority chain behind the four worker task tools.
//
// The MCP bridge that exposes those tools runs as a separate per-turn process
// with no view of the registry, the approval card, or SSH. It calls the
// harness's loopback endpoint, and the endpoint calls this. Everything that
// decides anything lives here:
//
//   propose   parse and bind the manifest → register it → ask a person →
//             stage → validate → activate. Only then is the worker unbounded.
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
  cancelWorkerTaskApproval,
  requestWorkerTaskApproval,
  type WorkerApprovalBus,
} from "./worker-task-approval.ts";
import {
  parseWorkerTaskManifest,
  workerTaskManifestDigest,
  type WorkerTaskManifest,
  WorkerTaskRegistry,
} from "./worker-task-manifest.ts";
import {
  activateWorkerTask,
  defaultWorkerTaskStreamRunner,
  fetchWorkerResults,
  resetWorkerTask,
  runWorkerCommand,
  stageWorkerTask,
  validateWorkerTask,
  type WorkerTaskStreamRunner,
} from "./worker-task-transport.ts";

/** Per artefact, so a large diff cannot flood a turn's context. */
const MAX_ARTEFACT_CHARS = 64 * 1024;

const requestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("propose"), manifest: z.json() }),
  z.object({ op: z.literal("status") }),
  z.object({ op: z.literal("run"), commandId: z.string().max(128) }),
  z.object({ op: z.literal("results") }),
]);

/** What activation produced, kept beside the registry's approval. Memory only,
 * for the same reason: a restart must not leave a worker looking unlocked. */
interface Activation {
  taskRoot: string;
  capabilitySha256: string;
}

export interface WorkerTaskServiceDeps {
  bus: WorkerApprovalBus;
  registry: WorkerTaskRegistry;
  /** The worker this bot is assigned to, or null when it has none. */
  workerFor: (bot: BotRecord) => ResolvedWorker | null;
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
  error?: string;
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

  async handle(bot: BotRecord, body: JsonValue): Promise<WorkerTaskOutcome> {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, error: schemaIssue(parsed.error, "unknown worker task operation") };
    }
    const worker = this.deps.workerFor(bot);
    if (!worker) return { status: 409, error: "this bot is not assigned to a configured worker" };

    try {
      switch (parsed.data.op) {
        case "propose":
          return await this.propose(bot, worker, parsed.data.manifest);
        case "status":
          return this.status(bot);
        case "run":
          return await this.run(bot, worker, parsed.data.commandId);
        case "results":
          return await this.results(bot, worker);
      }
    } catch (error) {
      // A failed task is a normal outcome for the model to read and react to,
      // not a transport fault: 200 with an explanatory body would hide it, and
      // a 500 would read as "OpenMausBot broke". 409 says "this did not run".
      return { status: 409, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async propose(bot: BotRecord, worker: ResolvedWorker, raw: JsonValue): Promise<WorkerTaskOutcome> {
    if (!bot.cwd) {
      return {
        status: 409,
        error:
          "this bot has no working folder, so there is nothing to stage — " +
          "set one in the bot's settings before proposing a worker task",
      };
    }
    // Re-serialized and re-parsed so `parseWorkerTaskManifest` sees a plain JSON
    // value and never a live object carrying getters or a prototype.
    const document: JsonValue = parseJson(JSON.stringify(raw ?? null));
    const manifest = parseWorkerTaskManifest(document, worker, this.now());
    if (manifest.threadId !== bot.threadId) {
      throw new Error("the task manifest names a different conversation");
    }
    const digest = workerTaskManifestDigest(manifest);
    this.deps.registry.register(manifest);

    const verdict = await requestWorkerTaskApproval(this.deps.bus, worker, manifest, digest, bot.threadId);
    if (verdict !== "allow") {
      return { status: 200, text: "The person denied this task. Nothing was staged, activated or run." };
    }
    if (!this.deps.registry.approve(manifest.taskId, digest, this.now())) {
      throw new Error("the task expired before it was approved");
    }

    await stageWorkerTask(worker, bot.cwd, manifest, this.streamRunner);
    const validated = await validateWorkerTask(worker, manifest, digest, this.runner);
    const activated = await activateWorkerTask(
      worker,
      manifest,
      digest,
      validated.taskRoot,
      this.runner,
      this.now(),
    );
    this.activations.set(manifest.taskId, {
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
  }

  /** The current task and its live approval, or an explanation of why there is
   * none. Never mints an approval as a side effect of being asked. */
  private status(bot: BotRecord): WorkerTaskOutcome {
    const record = this.deps.registry.forThread(bot.threadId);
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
  private approvedFor(bot: BotRecord): ApprovedTask {
    const record = this.deps.registry.forThread(bot.threadId);
    if (!record) throw new Error("no worker task has been proposed in this conversation");
    const live = this.deps.registry.approved(record.manifest.taskId, record.digest, this.now());
    if (!live) throw new Error("this task is no longer approved — propose it again");
    if (!this.activations.has(live.manifest.taskId)) throw new Error("this task was never activated on the worker");
    return { manifest: live.manifest, digest: live.digest };
  }

  private async run(bot: BotRecord, worker: ResolvedWorker, commandId: string): Promise<WorkerTaskOutcome> {
    const { manifest, digest } = this.approvedFor(bot);
    const result = await runWorkerCommand(worker, manifest, digest, commandId, this.runner);
    const body = [
      `${commandId} exited ${result.code ?? "without a status"}`,
      result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: (empty)",
      result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
    ].filter(Boolean);
    return { status: 200, text: body.join("\n\n") };
  }

  private async results(bot: BotRecord, worker: ResolvedWorker): Promise<WorkerTaskOutcome> {
    const { manifest, digest } = this.approvedFor(bot);
    const artefacts = await fetchWorkerResults(worker, manifest, digest, this.streamRunner);
    if (artefacts.length === 0) {
      return { status: 200, text: "The task has not produced any of its declared result artefacts yet." };
    }
    const sections = artefacts.map((artefact) => {
      const text = artefact.content.toString("utf8");
      const shown = text.length > MAX_ARTEFACT_CHARS
        ? `${text.slice(0, MAX_ARTEFACT_CHARS)}\n… truncated at ${MAX_ARTEFACT_CHARS} characters`
        : text;
      return `── ${artefact.path} (${artefact.content.length} bytes)\n${shown}`;
    });
    return { status: 200, text: sections.join("\n\n") };
  }

  /** Wipe a task off its worker and put the worker back on its deny-all
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
}
