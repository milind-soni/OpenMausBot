// One tool-free ACP exchange for memory upkeep: a fresh process and session, no MCP servers, an empty
// folder. It fails closed: any agent request, or any tool call it reports, ends the call.
import type { TextGenerationOptions, TextGenerationUsage } from "../../contracts.ts";
import type { killCliTree, spawnCli } from "../../procs.ts";

export const BACKGROUND_TEXT_TIMEOUT_MS = 120_000;
export const BACKGROUND_TEXT_MAX_CHARS = 200_000;
const MAX_STDOUT_BYTES = 4_000_000;

export interface AcpOneShotInput {
  displayName: string;
  spawn: typeof spawnCli;
  kill: typeof killCliTree;
  command: string;
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  prompt: string;
  /** The model usage is booked to when the session names none. */
  defaultModel: string;
  pickAuthMethod: (methods: Array<{ id?: string }>) => string | null;
  authRequired: boolean | "if-requested";
  loginNote: string;
  clientCapabilitiesMeta?: Record<string, unknown>;
  configure?: (ctx: { request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>; sessionId: string; session: any }) => Promise<void>;
  options?: TextGenerationOptions;
  timeoutMs?: number;
}

const REFUSAL = "OpenMausBot background text allows no tools, files, terminals or approvals.";

export function runAcpOneShot(input: AcpOneShotInput): Promise<string> {
  const { signal, onUsage } = input.options ?? {};
  const name = input.displayName;
  if (signal?.aborted) return Promise.reject(new Error(`${name} background call aborted`));
  return new Promise<string>((resolve, reject) => {
    const child = input.spawn(input.command, input.argv, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let buffer = "";
    let received = 0;
    let output = "";
    let sessionId: string | null = null;
    let model: string | undefined;
    let usage: TextGenerationUsage | undefined;
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

    const finish = async (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      for (const waiter of pending.values()) waiter.reject(error ?? new Error(`${name} background call closed`));
      pending.clear();
      // Windows keeps the session folder locked until the process exits.
      await input.kill(child).catch(() => undefined);
      if (!error && usage) {
        try {
          onUsage?.(usage);
        } catch {
          error = new Error(`${name} usage callback failed`);
        }
      }
      if (error) reject(error);
      else if (!output.trim()) reject(new Error(`${name} background call returned no text`));
      else resolve(output.trim());
    };
    const abort = () => finish(new Error(`${name} background call aborted`));
    const timer = setTimeout(() => finish(new Error(`${name} background call timed out`)), input.timeoutMs ?? input.options?.timeoutMs ?? BACKGROUND_TEXT_TIMEOUT_MS);
    timer.unref?.();

    const send = (message: unknown) => {
      if (settled) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {}
    };
    const request = (method: string, params: unknown): Promise<any> => new Promise((ok, fail) => {
      if (settled) return fail(new Error(`${name} background call closed`));
      const id = nextId++;
      pending.set(id, { resolve: ok, reject: fail });
      send({ jsonrpc: "2.0", id, method, params });
    });

    const onMessage = (msg: any) => {
      if (msg?.id !== undefined && msg.method === undefined) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (!waiter) return;
        if (msg.error) waiter.reject(new Error(`${name} background ${typeof msg.error?.message === "string" ? msg.error.message.slice(0, 200) : "request failed"}`));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg?.id !== undefined && typeof msg.method === "string") {
        send(msg.method === "session/request_permission"
          ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
          : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: REFUSAL } });
        finish(new Error(`${name} background call asked for ${msg.method}, which it may not use`));
        return;
      }
      if (msg?.method !== "session/update") return;
      if (sessionId !== null && msg.params?.sessionId !== undefined && msg.params.sessionId !== sessionId) return;
      const update = msg.params?.update;
      const kind = update?.sessionUpdate;
      if (kind === "tool_call" || kind === "tool_call_update") {
        finish(new Error(`${name} background call tried to use a tool`));
        return;
      }
      if (kind === "agent_message_chunk") {
        const text = update?.content?.text;
        if (typeof text !== "string") return;
        output += text;
        if (output.length > BACKGROUND_TEXT_MAX_CHARS) finish(new Error(`${name} background answer exceeded its limit`));
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on("close", (code) => finish(new Error(`${name} background process exited ${code ?? "on a signal"}`)));
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      received += chunk.length;
      if (received > MAX_STDOUT_BYTES) return finish(new Error(`${name} background output exceeded its limit`));
      buffer += chunk;
      let newline: number;
      while (!settled && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          // agents print banners and logs on stdout; only JSON lines count
          continue;
        }
        onMessage(msg);
      }
    });
    signal?.addEventListener("abort", abort, { once: true });

    (async () => {
      const init = await request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "openmausbot_memory", version: "1" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(input.clientCapabilitiesMeta ? { _meta: input.clientCapabilitiesMeta } : {}),
        },
      });
      const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
      const methodId = input.pickAuthMethod(methods);
      if (methodId) {
        try {
          await request("authenticate", { methodId });
        } catch {
          if (input.authRequired) throw new Error(input.loginNote);
        }
      } else if (input.authRequired === true) {
        throw new Error(input.loginNote);
      }
      const session = await request("session/new", { cwd: input.cwd, mcpServers: [] });
      if (typeof session?.sessionId !== "string") throw new Error(`${name} background session/new returned no sessionId`);
      sessionId = session.sessionId;
      model = typeof session?.models?.currentModelId === "string" ? session.models.currentModelId
        : typeof init?._meta?.modelState?.currentModelId === "string" ? init._meta.modelState.currentModelId : undefined;
      await input.configure?.({ request: (method, params) => request(method, params), sessionId: session.sessionId, session });
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }] });
      const reported = result?.usage ?? result?._meta ?? {};
      const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
      if (count(reported.inputTokens) !== undefined || count(reported.outputTokens) !== undefined) {
        usage = { model: model ?? input.defaultModel, input: count(reported.inputTokens), output: count(reported.outputTokens) };
      }
      if (result?.stopReason !== "end_turn") throw new Error(`${name} background call stopped: ${String(result?.stopReason ?? "unknown")}`);
      finish();
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
