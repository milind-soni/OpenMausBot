import { randomUUID } from "node:crypto";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceConfigs, type AppConfig } from "./config.ts";
import { stripWorkspaceCredentialEnv } from "./credential-env.ts";
import { codexShellDisabled, GUEST_CONFINED_CODEX_ARGS } from "./drivers/codex-guest.ts";
import { codexLaunch } from "./drivers/codex-process.ts";
import { CodexConnection } from "./drivers/codex-warm.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { LiveSessionError, MAX_SDP_BYTES } from "./live-call.ts";
import type { LiveSocket } from "./live-call-controller.ts";

const START_TIMEOUT_MS = 25_000;
const START_FAILED = "Codex could not start Live calls. Update Codex CLI and check its ChatGPT sign-in.";
const AUTH_REQUIRED = "Sign in to Codex with ChatGPT in Settings → AI to use Live calls.";
const THREAD_SCOPE_FAILED = "Codex could not start a Live call with its tools disabled. Update Codex CLI and try again.";
const VOICE_PROMPT = "You are the voice for a MausBot call. MausBot sends the person's requests to their bot. Briefly acknowledge in the person's language while waiting, and read only the bot's replies when MausBot sends them. Leave work and tool calls to the bot.";
const DISABLED_FEATURES = ["apps", "plugins", "hooks", "multi_agent", "multi_agent_v2", "image_generation"] as const;

export interface LiveCodexCli {
  cli: string;
  environment?: NodeJS.ProcessEnv;
}

export function localLiveCodex(cfg: AppConfig, desktop: boolean): LiveCodexCli | null {
  if (!desktop || process.platform !== "darwin") return null;
  const instance = instanceConfigs(cfg).codex;
  if (instance?.driver !== "codex" || instance.enabled === false) return null;
  const options = instance.config as { cli?: string; authMode?: string; endpoint?: unknown; managed?: unknown } | undefined;
  if (options?.authMode === "chatgpt-plan" || options?.endpoint || options?.managed) return null;
  return { cli: options?.cli || "codex", environment: instance.environment };
}

type VoiceConfig = {
  features?: Record<string, unknown>;
  web_search?: string;
  mcp_servers?: Record<string, { enabled?: boolean }>;
  experimental_realtime_webrtc_call_base_url?: string;
  experimental_realtime_ws_base_url?: string;
};

type VoiceNotice = { method?: string; params?: { threadId?: string; sdp?: string; role?: string; text?: string; turn?: { id?: string } } };

function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function openCodexVoiceProcess(input: LiveCodexCli, cwd: string, deadline: AbortSignal, disabledMcp: string[], onNotice: (note: VoiceNotice) => void, onExit: () => void) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...input.environment, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of ["OPENAI_API_KEY", "OPENMAUSBOT_CODEX_API_KEY", "OPENMAUSBOT_CHATGPT_TOKEN"]) delete env[key];
  const args = ["app-server", ...GUEST_CONFINED_CODEX_ARGS, ...DISABLED_FEATURES.flatMap((name) => ["--disable", name])];
  if (disabledMcp.length) {
    const disabled = disabledMcp.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",");
    args.push("-c", `mcp_servers={${disabled}}`);
  }
  const connection = new CodexConnection(spawnCli(...codexLaunch(input.cli, args), { cwd, env, stdio: "pipe" }));
  const exit = new AbortController();
  const signal = AbortSignal.any([deadline, exit.signal]);
  const failed = () => {
    if (exit.signal.aborted) return;
    exit.abort(new LiveSessionError(START_FAILED, 502));
    onExit();
  };
  connection.child.stdin.on("error", failed);
  connection.attach({
    error: failed, close: failed,
    message: (message) => { if (!connection.absorb(message)) onNotice(message); },
  });
  return {
    ask: async <T>(method: string, params: object, duringCall = false): Promise<T> => {
      const limit = duringCall ? AbortSignal.any([exit.signal, AbortSignal.timeout(8_000)]) : signal;
      const result = await until(connection.ask(method, params), limit);
      if (result === undefined) throw new LiveSessionError(START_FAILED, 502);
      return result as T;
    },
    notify: (method: string) => connection.write({ jsonrpc: "2.0", method }),
    close: () => {
      exit.abort(new LiveSessionError(START_FAILED, 502));
      return killCliTree(connection.child);
    },
    signal,
  };
}

function assertVoiceConfig(config: VoiceConfig | undefined): asserts config is VoiceConfig {
  if (!config || !codexShellDisabled(config) || config.web_search !== "disabled" || DISABLED_FEATURES.some((name) => config.features?.[name] !== false)) {
    throw new LiveSessionError(THREAD_SCOPE_FAILED, 502);
  }
  if (config.experimental_realtime_webrtc_call_base_url || config.experimental_realtime_ws_base_url) {
    throw new LiveSessionError("Remove custom Codex voice endpoints to use the ChatGPT Live call service.", 502);
  }
}

const enabledMcp = (config: VoiceConfig): string[] => Object.entries(config.mcp_servers ?? {}).filter(([, server]) => server.enabled !== false).map(([name]) => name);

export async function createCodexLiveSession(input: LiveCodexCli & { sdp: string; voice: string }): Promise<{ sessionId: string; sdp: string; socket: LiveSocket }> {
  const sessionId = randomUUID();
  const deadline = AbortSignal.timeout(START_TIMEOUT_MS);
  const cwd = mkdtempSync(join(tmpdir(), "mausbot-codex-voice-"));
  const launchedAt = Date.now();
  let process: ReturnType<typeof openCodexVoiceProcess> | undefined;
  let threadId = "", sdp = "";
  let started = false, ready = false, closed = false, stopping = false;
  let offset = 0, sequence = 0;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void connected.catch(() => undefined);

  const close = async () => {
    if (closed) return;
    closed = true;
    await process?.close();
    try { rmdirSync(cwd); } catch {}
  };
  const finish = (failed: boolean) => {
    if (closed) return;
    if (!ready) rejectReady(new LiveSessionError(START_FAILED, 502));
    if (failed) socket.onclose?.(undefined);
    else socket.onmessage?.({ data: JSON.stringify({ type: "session.closed", reason: "remote_hangup" }) });
    void close();
  };
  const socket: LiveSocket = {
    get readyState() { return closed ? 3 : ready ? 1 : 0; },
    onopen: null, onmessage: null, onerror: null, onclose: null,
    send(data) {
      if (closed || stopping) return;
      const event = JSON.parse(data) as { type: string; content?: string };
      if (event.type === "session.close") {
        stopping = true;
        void process?.ask("thread/realtime/stop", { threadId }, true).then(() => finish(false), () => finish(true));
      } else if ((event.type === "session.commentary.append" || event.type === "session.instructions.append") && event.content) {
        void process?.ask("thread/realtime/appendSpeech", { threadId, text: event.content }, true).catch(() => finish(true));
      }
    },
    close: () => { void close(); },
  };
  const emit = (event: object) => socket.onmessage?.({ data: JSON.stringify(event) });
  const onNotice = ({ method, params }: VoiceNotice) => {
    if (!threadId || params?.threadId !== threadId || closed) return;
    if (method === "thread/realtime/started") started = true;
    if (method === "thread/realtime/sdp" && typeof params.sdp === "string" && Buffer.byteLength(params.sdp) <= MAX_SDP_BYTES) sdp = params.sdp;
    if (method === "thread/realtime/closed" || method === "thread/realtime/error") finish(method === "thread/realtime/error");
    if (method === "turn/started" && typeof params.turn?.id === "string") {
      void process?.ask("turn/interrupt", { threadId, turnId: params.turn.id }, true).catch(() => finish(true));
    }
    if (started && sdp && !closed) resolveReady();
    if (!ready || stopping || method !== "thread/realtime/transcript/done" || params.role !== "user" || typeof params.text !== "string" || !params.text.trim()) return;
    offset = Math.max(offset + 1, Date.now() - launchedAt);
    emit({ type: "session.input_transcript.delta", delta: params.text, start_ms: offset, end_ms: offset + 1 });
    emit({ type: "session.delegation.created", delegation: { target: "client", id: `codex-${++sequence}` }, offset_ms: offset });
  };
  const startProcess = async (disabledMcp: string[]) => {
    const child = openCodexVoiceProcess(input, cwd, deadline, disabledMcp, onNotice, () => { if (ready) finish(true); });
    process = child;
    await child.ask("initialize", { clientInfo: { name: "openmausbot_voice", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.notify("initialized");
    const { config } = await child.ask<{ config?: VoiceConfig }>("config/read", { cwd, includeLayers: false });
    assertVoiceConfig(config);
    return { child, config };
  };
  try {
    let voiceProcess = await startProcess([]);
    const mcp = enabledMcp(voiceProcess.config);
    if (mcp.length) {
      await voiceProcess.child.close();
      voiceProcess = await startProcess(mcp);
      if (enabledMcp(voiceProcess.config).length) throw new LiveSessionError(THREAD_SCOPE_FAILED, 502);
    }
    const { child } = voiceProcess;
    const { account } = await child.ask<{ account?: { type?: string } }>("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt") throw new LiveSessionError(AUTH_REQUIRED, 401);
    const { thread, sandbox } = await child.ask<{ thread?: { id?: string }; sandbox?: { type?: string } }>("thread/start", {
      cwd, ephemeral: true, environments: [], sandbox: "read-only", approvalPolicy: "never", modelProvider: "openai",
    });
    if (typeof thread?.id !== "string" || !thread.id || sandbox?.type !== "readOnly") throw new LiveSessionError(THREAD_SCOPE_FAILED, 502);
    threadId = thread.id;
    await child.ask("thread/realtime/start", {
      threadId, outputModality: "audio", version: "v3", voice: input.voice,
      voiceSessionId: sessionId, includeStartupContext: false, clientManagedHandoffs: true,
      transport: { type: "webrtc", sdp: input.sdp }, prompt: VOICE_PROMPT,
    });
    await until(connected, child.signal);
    if (closed || child.signal.aborted) throw new LiveSessionError(START_FAILED, 502);
    ready = true;
    return { sessionId, sdp, socket };
  } catch (error) {
    await close();
    if (error instanceof LiveSessionError) throw error;
    throw new LiveSessionError(START_FAILED, 502);
  }
}
