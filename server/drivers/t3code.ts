// T3 Code (pingdotgg/t3code, t3 0.1.11) as an engine. T3 Code has no agent protocol of its own: its `t3` CLI is a client of the
// person's running T3 Code, so each turn is one `t3 thread start|send --wait --json` call, and the T3 thread id is the
// resume cursor. The agent itself (Claude, Codex, ...) runs inside T3 Code, with T3 Code's own sign-ins and access level.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PROVIDER_CREDENTIAL_ENV, stripControlPlaneEnv, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import type {
  ModelCatalog, ProviderAdapter, ProviderDriver, ProviderInstance, ProviderSnapshot, RuntimeEvent,
  RuntimeEventListener, SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { redactSecretsInText } from "../redact.ts";

const DRIVER_KIND = "t3codeAgent";
const EXEC_TIMEOUT_MS = 15_000;

/** Model ids are `<T3 provider instance>/<model>`, the pair `t3 thread start --provider --model` takes. */
const DEFAULT_MODELS: ModelCatalog = {
  default: "claudeAgent/claude-sonnet-5-5",
  options: [
    { id: "claudeAgent/claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claudeAgent/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claudeAgent/claude-haiku-5-5", label: "Claude Haiku 5.5" },
    { id: "codex/gpt-6.2-sol", label: "GPT-6.2 Sol" },
    { id: "codex/gpt-6.2-astra", label: "GPT-6.2 Astra" },
  ],
};

const configSchema = z.object({ cli: z.string().trim().min(1).default("t3") });
type T3Config = z.output<typeof configSchema>;

const resultSchema = z.object({
  threadId: z.string().min(1),
  status: z.string(),
  reply: z.string().nullish(),
  error: z.string().nullish(),
});

export const T3_ONLY_FULL_ACCESS =
  "T3 Code runs each thread at the access level set in T3 Code, so it only runs here at Full access. Set this bot to Full access, or choose another engine.";
export const T3_NOT_RUNNING = "T3 Code isn't running. Open T3 Code, or run `t3 serve` in a terminal, then try again.";

export function t3Selection(model: string): { provider: string; model: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`T3 Code model "${model}" must be <provider>/<model>, such as claudeAgent/claude-sonnet-5-5.`);
  }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/** T3's CLI prints errors as a log line plus a stack; keep the sentence a person can act on. */
export function t3ErrorText(stderr: string): string {
  if (/No running T3 Code server/.test(stderr)) return T3_NOT_RUNNING;
  const line = stderr.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("at "));
  return (line ?? "T3 Code failed without saying why.").replace(/^\[[\d:.]+\] ERROR \(#\d+\): /, "");
}

interface T3Run { code: number | null; stdout: string; stderr: string }
interface ActiveTurn { turnId: string; child?: ReturnType<typeof spawnCli>; interrupted: boolean }
interface ThreadState { t3ThreadId?: string; active?: ActiveTurn }

export const T3CodeDriver: ProviderDriver<T3Config> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "T3 Code", supportsMultipleInstances: true, access: "subscription" },
  models: DEFAULT_MODELS,
  install: { docsUrl: "https://github.com/pingdotgg/t3code" },
  decodeConfig: (raw) => configSchema.parse(raw ?? {}),
  defaultConfig: () => configSchema.parse({}),
  async create(input): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    // T3 Code 0.1.11 writes its launcher to ~/.t3/bin, which is not on this app's PATH.
    const homeCli = join(homedir(), ".t3", "bin", "t3");
    const cli = config.cli === "t3" && existsSync(homeCli) ? homeCli : config.cli;
    const listeners = new Set<RuntimeEventListener>();
    const threads = new Map<string, ThreadState>();
    let version: string | undefined;

    const emit = (event: Record<string, unknown> & { type: RuntimeEvent["type"]; threadId: string }) => {
      const full = { eventId: newEventId(), provider: DRIVER_KIND, providerInstanceId: instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
      for (const listener of listeners) listener(full);
    };

    const childEnv = (): NodeJS.ProcessEnv => {
      const env: Record<string, string | undefined> = { ...process.env, ...input.environment, PATH: augmentedPath() };
      for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) delete env[key];
      stripControlPlaneEnv(env);
      return env;
    };

    const exec = (args: string[]) => new Promise<T3Run>((resolve) => {
      execCli(cli, args, { env: childEnv(), timeout: EXEC_TIMEOUT_MS }, (error, stdout, stderr) => {
        const exit = (error as { code?: unknown } | null)?.code;
        const code = error ? (typeof exit === "number" ? exit : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
      });
    });

    const run = (active: ActiveTurn, args: string[], stdin: string, cwd: string) => new Promise<T3Run>((resolve, reject) => {
      // Out of the bot box: this child only asks the local T3 Code server to run the turn, and the box would cut it off.
      const child = spawnCli(cli, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], box: false }, "bot");
      active.child = child;
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => reject(new Error(describeSpawnFailure(error, cli, cwd).message)));
      child.once("close", (code) => {
        if (active.child === child) active.child = undefined;
        resolve({ code, stdout, stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    });

    const runTurn = async (state: ThreadState, turn: SendTurnInput, active: ActiveTurn): Promise<boolean> => {
      const threadId = turn.threadId;
      const { turnId } = active;
      if ((turn.approvalMode ?? "full") !== "full") throw new Error(T3_ONLY_FULL_ACCESS);
      const cwd = turn.cwd ?? homedir();
      const cursor = turn.sessionReset ? undefined
        : typeof turn.resumeCursor === "string" && turn.resumeCursor ? turn.resumeCursor : state.t3ThreadId;

      let result: T3Run | undefined;
      let rebuilt = false;
      if (cursor) {
        result = await run(active, ["thread", "send", cursor, "-", "--wait", "--json"], turn.text, cwd);
        if (result.code !== 0 && /was not found/.test(result.stderr)) {
          if (!turn.recoveryText) throw new Error("T3 Code no longer has this conversation's thread.");
          result = undefined;
          rebuilt = true;
        }
      }
      if (!result) {
        if (active.interrupted) return false;
        const selection = t3Selection(turn.model || DEFAULT_MODELS.default);
        const text = [turn.system, rebuilt ? turn.recoveryText : turn.text].filter(Boolean).join("\n\n");
        const title = turn.text.split("\n").find((line) => line.trim())?.trim().slice(0, 80) || "MausBot";
        const start = () => run(active, ["thread", "start", cwd, "-", "--title", title, "--provider", selection.provider,
          "--model", selection.model, "--wait", "--json"], text, cwd);
        result = await start();
        if (result.code !== 0 && /No T3 Code project matches/.test(result.stderr) && !active.interrupted) {
          const added = await run(active, ["project", "add", cwd], "", cwd);
          if (added.code !== 0) throw new Error(t3ErrorText(added.stderr));
          result = await start();
        }
      }
      if (active.interrupted) return false;

      let parsed: z.output<typeof resultSchema> | undefined;
      try { parsed = resultSchema.parse(JSON.parse(result.stdout)); } catch { parsed = undefined; }
      if (parsed && parsed.threadId !== state.t3ThreadId) {
        state.t3ThreadId = parsed.threadId;
        emit({ type: "session.started", threadId, turnId, sessionId: parsed.threadId, model: turn.model ?? null, ...(rebuilt ? { rebuilt: true } : {}) });
      }
      if (result.code === 0 && parsed?.status === "completed") {
        if (parsed.reply) emit({ type: "item.completed", threadId, turnId, itemId: newId(), itemType: "assistant_text", text: parsed.reply });
        return true;
      }
      if (result.code === 2) {
        const shown = parsed ? await exec(["thread", "show", parsed.threadId, "--json", "--messages", "0"]) : undefined;
        let link: string | undefined;
        try { link = z.object({ thread: z.object({ link: z.string() }) }).parse(JSON.parse(shown?.stdout ?? "")).thread.link; } catch { link = undefined; }
        throw new Error(`T3 Code is waiting for your answer${link ? ` in ${link}` : ""}. Answer it in T3 Code, then send your next message here.`);
      }
      throw new Error(parsed?.error || t3ErrorText(result.stderr));
    };

    const finish = (state: ThreadState, threadId: string, active: ActiveTurn, ok: boolean, stopReason: string) => {
      if (state.active === active) state.active = undefined;
      emit({ type: "turn.completed", threadId, turnId: active.turnId, ok, stopReason });
    };

    const adapter: ProviderAdapter = {
      provider: DRIVER_KIND,
      capabilities: { sessionModelSwitch: "unsupported", strictResume: true },
      async sendTurn(turn) {
        const state = threads.get(turn.threadId) ?? {};
        threads.set(turn.threadId, state);
        if (state.active) throw new Error("T3 Code is still working on this conversation's last message.");
        const active: ActiveTurn = { turnId: newId(), interrupted: false };
        state.active = active;
        emit({ type: "turn.started", threadId: turn.threadId, turnId: active.turnId });
        void runTurn(state, turn, active).then((done) => {
          if (done) finish(state, turn.threadId, active, true, "end_turn");
        }, (error: unknown) => {
          if (active.interrupted) return;
          const message = redactSecretsInText(error instanceof Error ? error.message : String(error));
          emit({ type: "runtime.error", threadId: turn.threadId, turnId: active.turnId, message, terminal: true,
            ...(message === T3_NOT_RUNNING || message === T3_ONLY_FULL_ACCESS ? { setup: true } : {}) });
          finish(state, turn.threadId, active, false, "error");
        });
        return { turnId: active.turnId };
      },
      async interruptTurn(threadId) {
        const state = threads.get(threadId);
        const active = state?.active;
        if (!state || !active || active.interrupted) return;
        active.interrupted = true;
        if (active.child) await killCliTree(active.child);
        // t3 0.1.11 has no command to stop a run: only the wait here ends.
        emit({ type: "runtime.notice", threadId, turnId: active.turnId, message: "Stopped waiting. T3 Code may still finish this turn in its own thread." });
        finish(state, threadId, active, false, "interrupted");
      },
      async respondToRequest() {
        return "unavailable";
      },
      hasSession: (threadId) => Boolean(threads.get(threadId)?.t3ThreadId),
      async stopAll() {
        await Promise.all([...threads.keys()].map((threadId) => adapter.interruptTurn(threadId)));
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: DEFAULT_MODELS,
      modelsUnconfirmed: true,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        if (!version) {
          const probed = await exec(["--version"]);
          const match = /^t3 v(\S+)/m.exec(probed.stdout);
          if (probed.code !== 0 || !match) {
            return { state: "unavailable", reason: "T3 Code isn't installed on this computer. Install the T3 Code app, then open it once.", authenticated: false };
          }
          version = match[1];
        }
        // Any project path answers; only a missing server fails this way.
        const listed = await exec(["thread", "list", "--project", homedir(), "--json"]);
        if (listed.code !== 0 && /No running T3 Code server/.test(listed.stderr)) {
          return { state: "unavailable", reason: T3_NOT_RUNNING, authenticated: false, version };
        }
        return { state: "available", authenticated: true, version, billing: "subscription", account: { method: "login" } };
      },
      async dispose() {
        await adapter.stopAll();
        threads.clear();
        listeners.clear();
      },
    };
  },
};
