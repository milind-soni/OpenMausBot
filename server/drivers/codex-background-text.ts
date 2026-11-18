// One tool-free `codex exec` call for background steps (memory upkeep, skill review): a fresh process,
// no session saved, never a chat's thread. Isolation is all argv: `--ignore-user-config` (no MCP
// servers, plugins, notify or profiles; still signed in from CODEX_HOME), tools off, a read-only
// sandbox, an empty temp folder, `--ephemeral`, the prompt on stdin. Any item besides text or
// reasoning ends the call.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, SmallModelFallback, TextGenerationOptions, TextGenerationUsage } from "../contracts.ts";
import type { killCliTree, spawnCli } from "../procs.ts";
import { refusesModel } from "../quick-model-fallback.ts";
import { decodeCodexSelection, OFFICIAL_CODEX_PROVIDER } from "./codex-catalog.ts";
import { codexConfigProviderArgs } from "./codex-config-provider.ts";
import { codexToolSurfaceArgs } from "./codex-tool-surface.ts";
import { codexLocalProviderArgs } from "./local-inject.ts";

export const CODEX_BACKGROUND_TIMEOUT_MS = 120_000;
export const CODEX_BACKGROUND_MAX_CHARS = 200_000;
const MAX_STDOUT_BYTES = 4_000_000;

/** The smallest model the account lists (GPT-6 Luna is the catalog's "fast and affordable model"), at low effort. */
export const CODEX_BACKGROUND_MODELS = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"] as const;
export const CODEX_BACKGROUND_EFFORT = "low";
const SMALL_MODEL = /(?:^|[-.])(?:luna|mini|nano)(?:$|[-.])/i;

const providerOf = (id: string) => decodeCodexSelection(id).modelProvider ?? OFFICIAL_CODEX_PROVIDER;

/** A small model `provider` lists (OpenAI's in the documented order), or else for OpenAI the account's default. */
export function codexBackgroundModel(catalog: ModelCatalog, refused: ReadonlySet<string> = new Set(), provider: string = OFFICIAL_CODEX_PROVIDER): string | null {
  const official = provider === OFFICIAL_CODEX_PROVIDER;
  const listed = catalog.options.filter((option) => !(official && option.custom) && !refused.has(option.id) &&
    decodeCodexSelection(option.id).modelProvider === provider);
  if (official) for (const id of CODEX_BACKGROUND_MODELS) if (listed.some((option) => option.id === id)) return id;
  const small = listed.find((option) => SMALL_MODEL.test(decodeCodexSelection(option.id).model ?? option.id))?.id;
  return small ?? (official ? accountDefault(catalog) : null);
}

function accountDefault(catalog: ModelCatalog): string | null {
  return catalog.default || catalog.options.find((option) => !option.custom)?.id || catalog.options[0]?.id || null;
}

export interface CodexBackgroundRoute {
  model: string;
  /** Run once more on this when the provider refuses `model`, or OpenAI is blocked or unreachable from here. */
  retry?: string;
}

/** Background text stays on the provider the bot's own model runs on (a person's gateway when OpenAI is blocked
 * where they are). A sign-in that cannot use small models, or one OpenAI already turned away here, writes on the bot's
 * own model, or the account's default without one. */
export function codexBackgroundRoute(catalog: ModelCatalog, smallModelsUsable: boolean, fallback?: SmallModelFallback, openaiUnreachable = false): CodexBackgroundRoute | null {
  const own = fallback?.model || accountDefault(catalog);
  const provider = own ? providerOf(own) : OFFICIAL_CODEX_PROVIDER;
  const small = smallModelsUsable && !(openaiUnreachable && provider === OFFICIAL_CODEX_PROVIDER);
  const model = (small ? codexBackgroundModel(catalog, fallback?.refused, provider) : null) ?? own;
  if (!model) return null;
  return own && own !== model ? { model, retry: own } : { model };
}

/** OpenAI refusing this region (403 unsupported_country_region_territory), or no connection to it at all. */
const OPENAI_UNREACHABLE = /country, region,? or territory|unsupported_country|\b403\b|forbidden|error sending request|connection refused|dns error|failed to lookup address|network is unreachable/i;

export async function runCodexBackgroundRoute(
  route: CodexBackgroundRoute,
  run: (model: string) => Promise<string>,
  options: TextGenerationOptions = {},
  /** Told once OpenAI is blocked or unreachable from here; the next routes then skip its small models. */
  onOpenaiUnreachable?: () => void,
): Promise<string> {
  try {
    return await run(route.model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!route.retry) throw error;
    if (refusesModel(message, route.model)) options.fallback?.onRefused(route.model);
    else if (onOpenaiUnreachable && providerOf(route.model) === OFFICIAL_CODEX_PROVIDER && OPENAI_UNREACHABLE.test(message)) onOpenaiUnreachable();
    else throw error;
    return run(route.retry);
  }
}

/** `--ignore-user-config` drops the person's own providers: a local host's or config.toml's comes along as overrides. */
export function codexBackgroundProviderArgs(env: Record<string, string | undefined>, modelId: string): string[] {
  const local = codexLocalProviderArgs(env, modelId);
  return local.length ? local : codexConfigProviderArgs(env, modelId);
}

/** Features off (codex-cli 0.160.1 `codex features list`); an older Codex ignores unknown names. */
const BACKGROUND_FEATURES_OFF = [
  "shell_tool", "unified_exec", "shell_snapshot", "view_image", "image_generation",
  "apps", "plugins", "remote_plugin", "multi_agent", "hooks", "memories", "goals",
  "skill_mcp_dependency_install", "tool_suggest", "sleep_tool", "daemon_auto_start",
] as const;

export interface CodexBackgroundArgsInput {
  /** A bare id, as `-m` takes it; a provider rides separately. */
  model: string;
  modelProvider?: string | null;
  providerArgs: readonly string[];
  cwd: string;
}

export function codexBackgroundArgs(input: CodexBackgroundArgsInput): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--cd", input.cwd,
    "--model", input.model,
    "-c", `model_reasoning_effort=${JSON.stringify(CODEX_BACKGROUND_EFFORT)}`,
    "-c", 'approval_policy="never"',
    "-c", 'web_search="disabled"',
    ...(input.modelProvider ? ["-c", `model_provider=${JSON.stringify(input.modelProvider)}`] : []),
    ...input.providerArgs,
    ...codexToolSurfaceArgs(),
    ...BACKGROUND_FEATURES_OFF.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-",
  ];
}

const QUIET_ITEMS = new Set(["agent_message", "reasoning", "todo_list", "error"]);

export interface CodexOneShotInput {
  spawn: typeof spawnCli;
  kill: typeof killCliTree;
  cli: string;
  env: Record<string, string | undefined>;
  prompt: string;
  model: string;
  modelProvider?: string | null;
  providerArgs: readonly string[];
  options?: TextGenerationOptions;
  timeoutMs?: number;
  describeError?: (message: string) => string;
}

export async function runCodexOneShot(input: CodexOneShotInput): Promise<string> {
  const { signal, onUsage } = input.options ?? {};
  if (signal?.aborted) throw new Error("Codex background call aborted");
  const cwd = mkdtempSync(join(tmpdir(), "omb-codex-background-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const argv = codexBackgroundArgs({ model: input.model, modelProvider: input.modelProvider, providerArgs: input.providerArgs, cwd });
      const child = input.spawn(input.cli, argv, { cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], botWork: true });
      const describe = input.describeError ?? ((message: string) => message.slice(0, 400));
      let settled = false;
      let closed = false;
      let buffer = "";
      let received = 0;
      let stderr = "";
      let answer = "";
      let failure = "";
      let fatal = "";
      let usage: TextGenerationUsage | undefined;
      let completed = false;

      const finish = async (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        // Windows keeps the folder locked until the process is gone.
        if (!closed) await input.kill(child).catch(() => undefined);
        if (!error && usage) {
          try {
            onUsage?.(usage);
          } catch {
            error = new Error("Codex background usage callback failed");
          }
        }
        if (error) reject(error);
        else if (!answer.trim()) reject(new Error("Codex background call returned no text"));
        else resolve(answer.trim());
      };
      const abort = () => void finish(new Error("Codex background call aborted"));
      const timer = setTimeout(() => void finish(new Error(`Codex background call timed out${fatal ? `: ${describe(fatal)}` : ""}`)), input.timeoutMs ?? input.options?.timeoutMs ?? CODEX_BACKGROUND_TIMEOUT_MS);
      timer.unref?.();

      const onEvent = (event: any) => {
        const type = event?.type;
        if (type === "item.started" || type === "item.updated" || type === "item.completed") {
          const item = event.item ?? {};
          if (!QUIET_ITEMS.has(item.type)) {
            void finish(new Error(`Codex background call tried to use a tool (${String(item.type ?? "unknown")})`));
            return;
          }
          if (type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
            answer = item.text;
            if (answer.length > CODEX_BACKGROUND_MAX_CHARS) void finish(new Error("Codex background answer exceeded its limit"));
          }
          return;
        }
        if (type === "turn.completed") {
          completed = true;
          const reported = event.usage ?? {};
          const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
          // codex's input_tokens already includes the cached share.
          usage = {
            model: input.model,
            input: count(reported.input_tokens),
            output: count(reported.output_tokens),
            ...(count(reported.cached_input_tokens) !== undefined ? { cachedInput: count(reported.cached_input_tokens) } : {}),
          };
          return;
        }
        if (type === "turn.failed") {
          failure = typeof event.error?.message === "string" ? event.error.message : "the turn failed";
          return;
        }
        // A top-level error (no reconnect, refused sign-in); Codex follows it with turn.failed or an exit.
        if (type === "error" && typeof event.message === "string") fatal ||= event.message;
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        received += chunk.length;
        if (received > MAX_STDOUT_BYTES) return void finish(new Error("Codex background output exceeded its limit"));
        buffer += chunk;
        let newline: number;
        while (!settled && (newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          onEvent(event);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-8_192);
      });
      child.on("error", (error) => void finish(error instanceof Error ? error : new Error(String(error))));
      child.on("close", (code) => {
        closed = true;
        if (settled) return;
        if (buffer.trim()) {
          try { onEvent(JSON.parse(buffer)); } catch {}
          buffer = "";
        }
        if (failure || (!completed && fatal)) return void finish(new Error(`Codex background call failed: ${describe(failure || fatal)}`));
        if (!completed) {
          const said = stderr.trim().split("\n").filter(Boolean).at(-1);
          return void finish(new Error(`Codex background call exited ${code ?? "on a signal"}${said ? `: ${describe(said)}` : ""}`));
        }
        void finish();
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => { /* the close handler reports a dead child */ });
      child.stdin.end(input.prompt);
    });
  } finally {
    // On Windows the process can hold the folder a moment after it exits.
    try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
}
