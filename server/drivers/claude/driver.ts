// Claude driver — upstream ClaudeDriver skeleton over agentcal's
// drivers/claude.js runtime (stream-json both directions, prompt over
// stdin, completion from a real `result` event — verified against
// claude 2.1.211 by agentcal). Per-turn CLI process; the conversation
// continues across turns via --resume <sessionId> (the resumeCursor).
//
// Integrations become MCP servers on the CLI:
//   - Composio Sessions (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (box.ascii.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-box bridge
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
  SteerOutcome,
} from "../../contracts.ts";
import { newId } from "../../contracts.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { classifyResumeFailure, mayReplay, recoveryPromptFor } from "../../resume-recovery.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../retry.ts";
import { applyClaudeInject, mergeLocalInject } from "../local-inject.ts";
import { appendNative } from "../native.ts";
import { createDriverSessionRuntime, createRefreshModels } from "../driver-runtime.ts";
import { ClaudeLoginController } from "../claude-login-auth.ts";
import { questionChoices, parseChoices } from "../../../shared/ask-question.ts";
import {
  CLAUDE_ACCOUNT_ENV_KEYS,
  autoCompactWindow,
  claudeAuthStatus,
  claudeEnvironment,
  claudeInheritWarning,
  inheritsUserConfig,
  readClaudeAuthSettings,
} from "./env-auth.ts";
import { parseClaudeCliVersion, claudeCliSupports, claudeCliUpdate, type ClaudeCliVersion } from "./cli-version.ts";
import {
  DRIVER_KIND,
  STATIC_CLAUDE_MODELS,
  readClaudeModelCatalog,
  resolveClaudeTurnModel,
  type ClaudeConfig,
} from "./models.ts";
import {
  NODE_ENV_FLAG,
  PERM_PROXY_PATH,
  askQuestions,
  askSummary,
  brokerSocketCandidates,
  createPermissionBroker,
  permissionSocketPath,
  removePrivateTempDir,
} from "./permission-broker.ts";
import { decodeConfig } from "./decode.ts";
import {
  claudeUserMessage,
  diagnosticClaudeUserMessage,
  withVolatileNote,
  type ClaudeUserMessage,
} from "./user-message.ts";
import { handleLine } from "./stream-events.ts";
import { claudeTurnMcpServers } from "./turn-mcp.ts";
import { generateClaudeReview } from "./generate-review.ts";
import type { ActiveTurn, Session } from "./session.ts";

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  // npm on all three: the one recipe that is genuinely cross-platform. The
  // native installers differ per OS and would need verifying separately.
  install: {
    command: {
      darwin: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      win32: "npm install -g @anthropic-ai/claude-code",
    },
    needsNode: true,
    docsUrl: "https://claude.com/claude-code",
    signInCommand: "claude",
  },
  models: STATIC_CLAUDE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const environment = (model?: string | null) =>
      claudeEnvironment(config.managed ? undefined : model, { ...process.env, ...input.environment }, config.configDir, input.environment);
    const catalogEnv = environment();
    // Say it once where a headless or source run reads its logs; the Engines
    // page carries the same warning for the desktop (claudeInheritWarning).
    if (inheritsUserConfig(catalogEnv)) {
      console.error(`claude (${instanceId}): OMB_CLAUDE_INHERIT_USER_CONFIG=1 — bots inherit this machine's Claude Code MCP servers, skills, hooks and CLAUDE.md on every turn; remove it unless a bot needs a user-scope server`);
    }
    const catalog = createRefreshModels({
      initial: STATIC_CLAUDE_MODELS,
      // managed instances have no local catalog; unreadable settings keep the last usable catalog
      load: config.managed ? undefined : () => mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv),
    });
    const refreshModels = catalog.refreshModels;
    await refreshModels();

    // The installed CLI's version as snapshot() last read it, so a flag the
    // CLI does not know is never passed to it (CLAUDE_FLAG_FLOORS). The
    // harness snapshots every instance whenever it describes them — app
    // load, the Engines page, and right after `claude update`, which is
    // exactly when the answer changes — so a turn normally finds it filled.
    // Most turns before any snapshot assume a current CLI. A coordinated
    // turn checks first because the snapshot-refresh flag is newer than the
    // other context controls and an unknown flag would reject that request.
    let cliVersion: ClaudeCliVersion | null = null;
    let cliVersionChecked = false;
    const readCliVersion = (env: NodeJS.ProcessEnv): Promise<string | null> =>
      new Promise((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim() || null),
        );
      });

    const sessions = new Map<string, Session>();
    const configuredIdleMinimum = Number(process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS);
    const sessionIdleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0
      ? configuredIdleMinimum
      : 10_000;
    const SESSION_IDLE_MS = Math.max(sessionIdleMinimum, Number(process.env.OMB_CLAUDE_SESSION_IDLE_MS) || 10 * 60_000);

    const stopSession = (session: Session) => {
      void killCliTree(session.child).then((stopped) => {
        if (stopped) void session.finishClose?.();
      });
    };
    const closeSession = (threadId: string, why: string) => {
      const s = sessions.get(threadId);
      if (!s || s.closing) return;
      s.closing = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      // Broker ownership belongs to this session. Detach and close it now,
      // before a replacement can bind the same per-thread socket; the old
      // child's later close event must never unlink a new broker.
      const broker = s.broker;
      s.broker = undefined;
      broker?.close();
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { close: why } });
      // stdin EOF is the CLI's exit signal; give it a moment, then insist
      try {
        s.child.stdin.end();
      } catch {}
      const kill = setTimeout(() => {
        stopSession(s);
      }, 5_000);
      kill.unref?.();
    };
    const armIdle = (threadId: string) => {
      const s = sessions.get(threadId);
      if (!s) return;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => closeSession(threadId, "idle"), SESSION_IDLE_MS);
      s.idleTimer.unref?.();
    };
    const writeUser = (s: Session, threadId: string, promptMsg: ClaudeUserMessage): Promise<boolean> => {
      if (!s.child.stdin.writable || s.child.stdin.destroyed) return Promise.resolve(false);
      return new Promise((resolve) => {
        try {
          s.child.stdin.write(JSON.stringify(promptMsg) + "\n", (error) => {
            if (error) return resolve(false);
            appendNative(threadId, {
              dir: "out",
              source: "claude.sdk.message",
              msg: diagnosticClaudeUserMessage(promptMsg),
            });
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
    };

    const runtime = createDriverSessionRuntime<ActiveTurn>({
      driverKind: DRIVER_KIND,
      stopTurn: (turn) => turn.stop(),
      // stopAll/dispose also close idle sessions, which no running turn owns
      afterStopTurns: (source) => {
        for (const threadId of Array.from(sessions.keys())) closeSession(threadId, source);
      },
    });
    const { emit, base } = runtime;
    // retry bookkeeping lives PER THREAD, not per sendTurn call: a relaunch
    // is a fresh sendTurn, and the attempt cap must survive across launches
    const retryState = new Map<string, { attempt: number; cancelled: boolean; rebuilt?: boolean }>();

    const sendTurn = async (turn: SendTurnInput, logicalTurnId?: string) => {
      if (config.managed && (!turn.model || turn.model.includes("::") || !config.configDir ||
          !input.environment.ANTHROPIC_API_KEY || !input.environment.ANTHROPIC_BASE_URL)) {
        throw new Error("Company model access is unavailable. Reconnect your organization; personal billing will not be used.");
      }
      const { threadId, botId } = turn;
      // An internal relaunch (transient failure, rejected resume) keeps the
      // logical turn's stop handle registered while it sets up, so Stop is
      // never a silent no-op between two CLI processes of the same turn.
      const relaunch = logicalTurnId !== undefined;
      runtime.assertThreadIdle(threadId, { allowBusy: relaunch });
      // Internal relaunches are still the turn acknowledged to the harness.
      // A new user message gets a fresh id, but retry/recovery must not orphan
      // its capability, coordination result or queued continuation ownership.
      const turnId = logicalTurnId ?? newId();
      // Hold the thread from before the first await (CLI version probe, model
      // resolution, broker setup) until setTurn registers the turn, so a
      // stopAll()/dispose() during setup cancels the launch instead of racing
      // it; the catch releases the claim when setup fails before then.
      if (!relaunch) runtime.claimTurn(threadId, turnId);
      try {
        return await runClaimedTurn(turn, threadId, botId, relaunch, turnId);
      } catch (error) {
        if (!relaunch) runtime.endTurn(threadId, turnId);
        throw error;
      }
    };

    /** The body of sendTurn once the thread is claimed: a throw anywhere
     *  before setTurn releases the claim through the catch above. */
    const runClaimedTurn = async (
      turn: SendTurnInput,
      threadId: SendTurnInput["threadId"],
      botId: SendTurnInput["botId"],
      relaunch: boolean,
      turnId: string,
    ) => {
      // A bot-level mode is authoritative for this turn. In particular, an
      // old provider instance may still be configured with
      // `bypassPermissions`; Ask/Auto must restore Claude's interactive
      // broker instead of inheriting that silent bypass. Calls without a
      // per-turn mode keep the legacy adapter behavior.
      const permissionMode = turn.approvalMode === undefined
        ? config.permissionMode
        : turn.approvalMode === "full" ? "bypassPermissions"
          : turn.approvalMode === "auto" ? "auto"
            : turn.approvalMode === "edits" ? "acceptEdits" : "default";
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && permissionMode === "bypassPermissions" && turn.approvalMode !== "full") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      // Materialize before creating a broker or process. A missing/corrupt
      // attachment must fail this call without leaving a live session behind.
      const promptMsg = claudeUserMessage(turn.text, turn.images);
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      // A fresh user turn starts un-cancelled. A relaunch must keep a Stop
      // that landed while it was being scheduled.
      if (!relaunch) {
        retry.cancelled = false;
        retry.rebuilt = false;
      }
      retryState.set(threadId, retry);
      // a retry relaunches the whole CLI; the backoff is scaled down in tests
      // so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // required by stream-json output
        // token-level streaming: content_block_delta events between the
        // whole-message frames, so the bubble grows as the model writes
        "--include-partial-messages",
        "--permission-mode", permissionMode,
      ];
      if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      if (config.disallowedTools?.length) {
        args.push("--disallowedTools", config.disallowedTools.join(","));
      }
      const turnEnvironment = environment();
      if (turn.refreshSystemPrompt && !cliVersionChecked) {
        const version = await readCliVersion(turnEnvironment);
        if (version) {
          cliVersion = parseClaudeCliVersion(version);
          cliVersionChecked = true;
        }
      }
      const isolated = !inheritsUserConfig(turnEnvironment);
      if (isolated) {
        // A bot gets the tools and instructions its owner gave it, not
        // whatever this machine's Claude Code happens to be set up with.
        // Without these the CLI silently adds, to EVERY turn of every bot:
        // the desktop's own MCP servers and claude.ai connectors (one
        // measured desktop mounted 407 extra tools, ~10k tokens), its skill
        // and agent listings, its hooks, and its personal CLAUDE.md. Every
        // model call in the session then re-reads all of it.
        // Each flag only on a CLI that accepts it: an unknown flag is an
        // argument error that would fail every turn (CLAUDE_FLAG_FLOORS).
        // The MCP half has a switch (Plugins → MCP servers → "Also use my
        // Claude Code MCP servers"): with it on, the CLI loads the servers
        // and connectors from the person's own Claude Code config — the way
        // Codex reads its own config.toml — while skills, hooks and the
        // personal CLAUDE.md stay out.
        if (!turn.mcpFromUserConfig && claudeCliSupports(cliVersion, "--strict-mcp-config")) args.push("--strict-mcp-config");
        if (claudeCliSupports(cliVersion, "--setting-sources")) args.push("--setting-sources", "project");
      }
      const compactWindow = autoCompactWindow(turnEnvironment);
      if (compactWindow && claudeCliSupports(cliVersion, "--autocompact")) {
        args.push("--autocompact", compactWindow);
      }
      // An old pair conversation can still carry its first assignment in
      // Claude's recorded system prompt. The current brief rides in the user
      // turn, so refresh the recorded prompt on --resume too. Gated by the
      // version floor like every other flag the CLI may predate: an unknown
      // flag is a hard argument error, not a graceful degrade.
      if (turn.refreshSystemPrompt && cliVersionChecked && claudeCliSupports(cliVersion, "--system-prompt-snapshot")) {
        args.push("--system-prompt-snapshot", "off");
      }
      const turnModel = config.managed ? turn.model : await resolveClaudeTurnModel(turn.model, turnEnvironment);
      const injected = config.managed ? { model: turnModel ?? null, injected: false } : applyClaudeInject({ ...turnEnvironment }, turnModel);
      if (injected.model) args.push("--model", injected.model);
      if (turn.effort) args.push("--effort", turn.effort);

      // A room prompt can contain section context, skills, memory, playbooks,
      // and browser/agent instructions. Passing that text directly on argv
      // exceeds Windows' CreateProcess command-line limit and surfaces as
      // `spawn ENAMETOOLONG`. Claude accepts the same prompt from a file, so
      // keep both the text and its potentially sensitive contents off argv.
      let systemPromptPath: string | null = null;

      const { mcpServers, allowed } = claudeTurnMcpServers(turn, {
        threadId,
        turnEnvironment,
        controlsHost,
        isolated,
      });
      // Keep ask_user available even in Full access. Native bypass skips
      // permission prompts, not questions requiring a person's answer.
      let broker: Awaited<ReturnType<typeof createPermissionBroker>> | undefined;
      const socketPath = permissionSocketPath(threadId, botId);
      if (permissionMode !== "bypassPermissions") {
        args.push("--permission-prompt-tool", "mcp__ogb__approve");
      }
      mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG }, alwaysLoad: true };
      allowed.push("mcp__ogb");
      // The MCP config carries credentials — a Composio consumer key in a
      // header, the box token in the computer proxy's env, the comms token in
      // the agents proxy's env. On argv every one of those is world-readable
      // through `ps` for the life of the turn, to any local process. The CLI
      // accepts a FILE for this flag, so the secrets go in a 0600 file that
      // is removed when the turn settles.
      let mcpConfigPath: string | null = null;
      if (Object.keys(mcpServers).length) {
        mcpConfigPath = join(mkdtempSync(join(tmpdir(), "omb-mcp-")), "mcp.json");
        args.push("--mcp-config", mcpConfigPath);
        args.push("--allowedTools", allowed.join(","));
      }

      const env = environment(turnModel);
      const authSettings = isolated && !injected.injected
        ? readClaudeAuthSettings(env, input.environment) : {};
      const authSettingsPath = mcpConfigPath && Object.keys(authSettings).length
        ? join(dirname(mcpConfigPath), "auth-settings.json") : null;
      if (authSettingsPath) args.push("--settings", authSettingsPath);
      // Our approvals and browser credentials expire at the user-turn
      // boundary. Native background workers cannot outlive that boundary;
      // parallel bot work must use the harness's durable delegate_bot path.
      env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
      const cwd = turn.cwd ?? homedir();
      // Everything that shapes the process, minus session/turn-specific temp
      // paths. Their contents are represented directly in the key instead.
      const privateFileFlags = new Set(["--mcp-config", "--settings"]);
      const keyArgs = args.filter((a, i) => !privateFileFlags.has(a) && !privateFileFlags.has(args[i - 1] ?? ""));
      const argsKey = JSON.stringify({
        args: keyArgs,
        // the volatile half is deliberately absent: it must not respawn a
        // healthy session (see Session.volatile)
        system: turn.systemStable ?? turn.system ?? null,
        mcpServers,
        cwd,
        model: injected.model ?? null,
        base: env.ANTHROPIC_BASE_URL ?? null,
        configDir: env.CLAUDE_CONFIG_DIR ?? null,
        // Rotating an account's key/helper must not reuse the old process.
        auth: createHash("sha256").update(JSON.stringify({
          settings: authSettings,
          env: Object.fromEntries(CLAUDE_ACCOUNT_ENV_KEYS.map((key) => [key, env[key]])),
        })).digest("hex"),
      });

      // Reuse the live process when it is idle, unchanged, and is the session
      // the harness wants resumed. Anything else: close it and spawn fresh
      // (with --resume, so the conversation continues in the new process).
      const live = sessions.get(threadId);
      if (live && !live.turn && !live.closing && live.child.exitCode === null && live.argsKey === argsKey && (!sessionId || sessionId === live.sessionId)) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        // stopAll()/dispose() canceled this launch while it set up: the live
        // process was torn down with it, and no new turn may ride it
        if (!relaunch && runtime.claimCanceled(turnId)) {
          closeSession(threadId, "interrupted");
          runtime.endTurn(threadId, turnId);
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
          return { turnId };
        }
        live.turn = { turnId, input: turn, retryAbort, settled: false, sawStreamDelta: false };
        runtime.setTurn(threadId, { stop: () => {
          closeSession(threadId, "interrupted");
          retry.cancelled = true;
          retryAbort.abort();
          stopSession(live);
        }, turnId, broker: live.broker });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        const volatile = turn.systemVolatile ?? "";
        const message = volatile === live.volatile
          ? promptMsg
          : claudeUserMessage(withVolatileNote(turn.text, volatile), turn.images);
        live.volatile = volatile;
        const written = await writeUser(live, threadId, message);
        if (!written) {
          runtime.endTurn(threadId);
          live.turn = null;
          closeSession(threadId, "stdin write failed");
          retryState.delete(threadId);
          if (mcpConfigPath) {
            try {
              rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
            } catch {}
          }
          throw new Error("claude session stdin is not writable");
        }
        // the MCP config was for the first spawn; nothing to clean here
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        return { turnId };
      }
      if (live) closeSession(threadId, "spawn contract changed");

      // Until sessions.set() below, this turn owns every launch resource.
      // Any bind, private-config or synchronous spawn failure must release
      // them here rather than leave a live listener or credential temp file.
      const cleanupUnownedLaunch = () => {
        broker?.close();
        broker = undefined;
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
          mcpConfigPath = null;
        }
        if (systemPromptPath) {
          removePrivateTempDir(systemPromptPath);
          systemPromptPath = null;
        }
        retryState.delete(threadId);
      };

      try {
        // Create the prompt file only for a new process. A compatible live
        // session has already consumed the same system prompt at launch.
        if (turn.system) {
          systemPromptPath = join(mkdtempSync(join(tmpdir(), "omb-system-")), "prompt.txt");
          writeFileSync(systemPromptPath, turn.system, { mode: 0o600 });
          args.push("--append-system-prompt-file", systemPromptPath);
        }
        // Only create a broker for a new process. A compatible retained
        // process keeps its existing proxy connection and broker across turns.
        if (socketPath) {
          // remembers which tool each pending ask came from, so the resolved
          // event can scope approvals to real desktop-control tools only
          const askTools = new Map<string, string | undefined>();
          broker = await createPermissionBroker({
            socketPaths: brokerSocketCandidates(threadId, botId),
            isActive: () => Boolean(sessions.get(threadId)?.turn),
            onAsk: (ask) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
              // Auto was requested: say whether the CLI's reviewer is actually
              // running, from init, so the harness can tell a classifier's
              // verdict from a Manual session asking about everything.
              const nativeMode = sessions.get(threadId)?.nativePermissionMode ?? null;
              const nativeReview =
                permissionMode === "auto" && nativeMode !== null
                  ? nativeMode === "auto" ? "active" : "inactive"
                  : undefined;
              const questions = askQuestions(ask);
              emit({
                ...base(threadId, eventTurnId),
                type: "request.opened",
                requestId: ask.id,
                requestType: ask.kind,
                tool: ask.tool,
                summary: askSummary(ask),
                nativeReview,
                // the proxy hands Claude its own suggested rules on `always`;
                // host control stays one action at a time
                allowSession: ask.kind === "permission" && !(controlsHost && typeof ask.tool === "string" && ask.tool.startsWith("mcp__computer")) ? true : undefined,
                approvalScope:
                  typeof ask.tool === "string" && controlsHost && ask.tool.startsWith("mcp__computer")
                    ? "local-computer"
                    : undefined,
                questions: questions ?? undefined,
                // A structured ask still offers flat labels, for the phone
                // companions and any client that predates the question card.
                choices: questions ? questionChoices(questions) : parseChoices(ask.input?.choices),
              });
            },
            onResolve: (resolved) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              emit({
                ...base(threadId, eventTurnId),
                type: "request.resolved",
                requestId: resolved.id,
                behavior: resolved.behavior,
                source: resolved.source,
                approvalScope:
                  controlsHost && typeof askTools.get(resolved.id) === "string" && askTools.get(resolved.id)!.startsWith("mcp__computer") ? "local-computer" : undefined,
              });
              askTools.delete(resolved.id);
            },
          });
          // A fallback bind means the deterministic pipe is still held by an
          // earlier process's child. The proxy learns its path from argv, so
          // point it at the pipe we actually bound. argsKey deliberately keeps
          // the base path: the nonce is not part of the spawn contract, and a
          // retained session keeps its own broker object anyway.
          if (broker.socketPath !== socketPath && mcpConfigPath) {
            mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, broker.socketPath], env: { ...NODE_ENV_FLAG }, alwaysLoad: true };
          }
        }

        // Write once, only after the broker has selected its real endpoint.
        if (mcpConfigPath) {
          writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
        }
        if (authSettingsPath) {
          writeFileSync(authSettingsPath, JSON.stringify(authSettings), { mode: 0o600 });
        }
        if (sessionId) args.push("--resume", sessionId);
        else args.push("--session-id", newSessionId!);
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }

      // Stop reached the relaunch handle while this attempt was still setting
      // up (model probe, broker). Settle the logical turn as interrupted
      // instead of spawning a process nobody wants.
      if (relaunch && retry.cancelled) {
        cleanupUnownedLaunch();
        if (runtime.turn(threadId)?.turnId === turnId) runtime.endTurn(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        return { turnId };
      }

      // The fresh-turn counterpart: stopAll()/dispose() canceled this claim
      // while version/model/broker setup ran. Release the claim, settle as
      // interrupted, and spawn nothing.
      if (!relaunch && runtime.claimCanceled(turnId)) {
        cleanupUnownedLaunch();
        runtime.endTurn(threadId, turnId);
        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        return { turnId };
      }

      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }
      const session: Session = {
        child,
        broker,
        mcpConfigPath,
        systemPromptPath,
        argsKey,
        volatile: turn.systemVolatile ?? "",
        sessionId: sessionId ?? newSessionId,
        sawInit: false,
        nativePermissionMode: null,
        turn: { turnId, input: turn, retryAbort, settled: false, sawStreamDelta: false },
        idleTimer: null,
        closing: false,
        stderr: "",
      };
      sessions.set(threadId, session);

      // settles the TURN, not the process: the CLI stays for the next
      // message until it has been quiet for SESSION_IDLE_MS
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number; cachedInput?: number },
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.settled = true;
        // Resolve any ask still open for this turn, but keep the broker
        // listening for the next turn on the retained process. Between turns
        // isActive() rejects late background asks without creating cards.
        session.broker?.pause();
        // the config file holds live credentials — the CLI read it at start;
        // it must not sit on disk for the life of the session
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
          session.mcpConfigPath = null;
        }
        if (session.systemPromptPath) {
          if (removePrivateTempDir(session.systemPromptPath)) session.systemPromptPath = null;
        }
        runtime.endTurn(threadId);
        session.turn = null;
        // A settled turn owns no retry budget. Retained CLI sessions may run
        // many later turns on this thread, and each must start fresh.
        retryState.delete(threadId);
        emit({ ...base(threadId, t.turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
        if (session.child.exitCode === null && !session.closing) armIdle(threadId);
      };
      const currentTurnId = () => session.turn?.turnId ?? turnId;

      // Everything the per-line frame mapper needs from this turn; the
      // stream-json → RuntimeEvent mapping itself lives in stream-events.ts.
      const streamDeps = { session, threadId, settle, emit, base, currentTurnId, retry };

      let buf = "";
      // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
      // multibyte characters that straddle two reads and corrupts the text
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line, streamDeps);
        }
      });

      child.stderr.on("data", (c) => {
        session.stderr += c;
        if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, currentTurnId()), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      let closeFinalized = false;
      const finalizeClose = async (code: number | null) => {
        if (closeFinalized) return;
        // The root can close while its MCP helpers are still running. Join
        // an in-flight stop (or reap its remaining group) before releasing
        // the turn so a replacement cannot overlap the old helpers.
        if (!(await killCliTree(child, 0))) {
          session.broker?.close();
          session.broker = undefined;
          emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: "Claude could not be confirmed stopped; its helper processes may still be running." });
          return;
        }
        if (closeFinalized) return;
        closeFinalized = true;
        // a turn still running when the process died is a failed turn; a
        // process that exited between turns (idle close, contract change)
        // is just a session ending
        if (session.turn && !session.turn.settled) {
          // A retained process may be running a later user turn. Its close
          // handler must retry that request, not the process's first prompt.
          const { turnId, input: turn, retryAbort } = session.turn;
          const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
          const message = `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`;
          const verdict = classifyError({ exitCode: code, stderr: message });
          if (
            !retry.cancelled &&
            code !== 0 &&
            verdict.transient &&
            !session.turn.sawStreamDelta &&
            retry.attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            // the CLI is gone but the TURN continues: keep the thread busy,
            // emit no terminal event, and relaunch after the backoff. The
            // `active` entry STAYS — it is what makes an interrupt during
            // the backoff reach this turn's stop() and cancel the retry.
            const failedBroker = session.broker;
            session.broker = undefined;
            failedBroker?.pause();
            failedBroker?.close();
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            if (session.systemPromptPath) {
              removePrivateTempDir(session.systemPromptPath);
              session.systemPromptPath = null;
            }
            sessions.delete(threadId);
            session.turn = null;
            retry.attempt++;
            const delayMs = computeBackoff(retry.attempt - 1);
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: retry.attempt,
              delayMs,
              reason: verdict.reason,
            });
            void (async () => {
              const wait = interruptibleDelay(delayMs * retryScale, retryAbort.signal);
              await wait.promise;
              // an interrupt during the backoff landed here via stop(); the
              // turn settles as interrupted and no zombie relaunch happens
              if (retry.cancelled) {
                runtime.endTurn(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "interrupted",
                  cost: null,
                });
                return;
              }
              // Keep Stop reachable while the relaunch sets up: there is no
              // process yet, so this handle only records the cancellation and
              // the relaunched sendTurn honors it before spawning.
              retryState.set(threadId, retry);
              runtime.setTurn(threadId, { stop: () => { retry.cancelled = true; retryAbort.abort(); }, turnId });
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                await sendTurn({ ...turn, resumeCursor: cursor }, turnId);
              } catch (e) {
                if (runtime.turn(threadId)?.turnId === turnId) runtime.endTurn(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "exit_before_result",
                  cost: null,
                });
              }
            })();
            return;
          }
          // A --resume that the CLI never acknowledged: it exited without
          // an `init` frame, so it never read the prompt and this turn has
          // caused nothing. Without this the thread is BRICKED — the dead
          // cursor is never cleared, so every later turn resumes the same
          // missing session and fails identically, and the user has no way
          // back except switching engines. One fresh session, carrying the
          // harness's rebuild of the conversation. Exactly one: the relaunch
          // offers no cursor, so `attempted` is false there and a second
          // failure is reported like any other.
          const resumeFailure = classifyResumeFailure({
            attempted: Boolean(sessionId),
            rejected: !session.sawInit,
            promptSubmitted: session.sawInit,
            producedOutput: session.turn.sawStreamDelta,
          });
          if (mayReplay(resumeFailure) && !retry.cancelled) {
            const recovery = recoveryPromptFor({
              recoveryText: turn.recoveryText,
              currentText: turn.text,
              failure: resumeFailure,
            });
            session.broker?.close();
            session.broker = undefined;
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            if (session.systemPromptPath) {
              removePrivateTempDir(session.systemPromptPath);
              session.systemPromptPath = null;
            }
            sessions.delete(threadId);
            session.turn = null;
            // Same relaunch handle as the transient-retry path above. The new
            // session is announced as rebuilt only when it is actually given
            // the replay: with nothing to replay it gets the turn text alone.
            retry.rebuilt = recovery.replayed;
            retryState.set(threadId, retry);
            runtime.setTurn(threadId, { stop: () => { retry.cancelled = true; retryAbort.abort(); }, turnId });
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: retry.attempt + 1,
              delayMs: 0,
              reason: "resume_rejected",
            });
            void (async () => {
              try {
                // no cursor: a fresh session, carrying the rebuild
                await sendTurn({ ...turn, resumeCursor: undefined, recoveryText: undefined, text: recovery.text }, turnId);
              } catch (e) {
                if (runtime.turn(threadId)?.turnId === turnId) runtime.endTurn(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "exit_before_result", cost: null });
              }
            })();
            return;
          }
          retryState.delete(threadId);
          emit({
            ...base(threadId, currentTurnId()),
            type: "runtime.error",
            message,
          });
          settle(false, "exit_before_result");
        }
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.broker?.close();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        removePrivateTempDir(session.systemPromptPath);
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      };
      child.on("close", (code) => {
        session.finishClose = () => finalizeClose(code);
        void session.finishClose();
      });

      const stop = () => {
        // taskkill is asynchronous on Windows. Retire steering and approvals
        // now, before a still-connected child can submit more work.
        closeSession(threadId, "interrupted");
        retry.cancelled = true;
        retryAbort.abort();
        stopSession(session);
      };
      runtime.setTurn(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // prompt over stdin as a stream-json message — never argv (ARG_MAX).
      // stdin stays OPEN: that is what keeps the session alive for a
      // mid-turn steer or the next turn; closeSession() ends it.
      if (!(await writeUser(session, threadId, promptMsg))) {
        settle(false, "stdin_write_failed");
        closeSession(threadId, "stdin write failed");
      }

      return { turnId };
    };

    /** A user message into the running turn: the CLI delivers it before its
     * next model call. "refused" when nothing is running here to steer or
     * the stdin write provably failed; the caller queues those words. */
    const steer = async (threadId: string, text: string): Promise<SteerOutcome> => {
      const s = sessions.get(threadId);
      if (!s || !s.turn || s.turn.settled || s.closing || s.child.exitCode !== null) return "refused";
      return (await writeUser(s, threadId, claudeUserMessage(text, undefined))) ? "steered" : "refused";
    };

    // Sign in from Settings: the unmodified CLI's own login, driven over pipes
    // (server/drivers/claude-login-auth.ts). Same environment as every turn.
    const login = new ClaudeLoginController({ cli: config.cli, environment, onAuthenticated: async () => { await refreshModels(); } });

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = environment();
      const version = await readCliVersion(env);
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      cliVersion = parseClaudeCliVersion(version);
      cliVersionChecked = true;
      const auth = await claudeAuthStatus(config.cli, env);
      // claudeEnvironment strips ANTHROPIC_API_KEY, so turns run on the
      // CLI's own login (Pro/Max): the cost it reports is what the call
      // WOULD bill, not a charge
      const update = claudeCliUpdate(version, config.cli);
      const warning = claudeInheritWarning(env);
      return { state: "available", version, ...auth, ...(update ? { update } : {}), ...(warning ? { warning } : {}), billing: "subscription" };
    };

    /** One-shot Claude call with the prompt on stdin, never argv — the body
     * lives in generate-review.ts. */
    const generateReview = (prompt: string, signal?: AbortSignal): Promise<string> =>
      generateClaudeReview(config, environment, prompt, signal);

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return catalog.models;
      },
      refreshModels,
      snapshot,
      startAuthentication: () => login.start(),
      getAuthentication: (flowId) => login.get(flowId),
      completeAuthentication: (flowId, code) => login.complete(flowId, code),
      cancelAuthentication: () => login.cancel(),
      signOut: () => login.signOut(),
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          agentsMcp: true,
        customMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          images: true,
          nativeImageInput: true,
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          queueing: true,
          // Only while this CLI can be told to refresh a resumed session's
          // recorded system prompt (--system-prompt-snapshot). Keeping a
          // session across an update from outside it means the harness keeps
          // its prompt too; an older CLI would answer a delegated return with
          // the instructions of the turn that started the session, where a
          // fresh session rebuilt them. Unknown version: not yet.
          get strictResume() {
            return cliVersionChecked && cliVersion !== null && claudeCliSupports(cliVersion, "--system-prompt-snapshot");
          },
          // Harness turns reassert a per-bot mode and restore the broker even
          // when an old instance was configured with bypassPermissions.
          localComputerMcp: true,
        },
        sendTurn,
        steer,
        interruptTurn: async (threadId) => runtime.turn(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          // fail-closed by construction: no broker, or an ask that already
          // timed out / settled, is `unavailable` — the caller denies
          const broker = sessions.get(threadId)?.broker ?? runtime.turn(threadId)?.broker;
          if (!broker) return "unavailable";
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message, decision.always)) return "unavailable";
          return behavior === "allow" ? "allowed-once" : behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => runtime.hasSession(threadId),
        stopAll: () => runtime.stopAll(),
        onEvent: runtime.onEvent,
      },
      generateText: (prompt, options) => generateReview(prompt, options?.signal),
      reviewPermission: generateReview,
      dispose: async () => {
        try {
          await login.dispose();
        } finally {
          await runtime.dispose();
        }
      },
    };
  },
};
