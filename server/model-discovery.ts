import { execCli, killCliTree, spawnCli } from "./procs.ts";
import { augmentedPath } from "./env-path.ts";
import type { ModelCatalog } from "./contracts.ts";

const DISCOVERY_TIMEOUT_MS = 12_000;
const MAX_OUTPUT = 1_000_000;

export function catalog(options: Array<{ id: string; label: string }>, preferred?: string): ModelCatalog {
  const seen = new Set<string>();
  const clean = options.filter(({ id }) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!clean.length) throw new Error("provider returned no selectable models");
  return { default: preferred && seen.has(preferred) ? preferred : clean[0].id, options: clean };
}

function childEnvironment(environment: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...environment, PATH: augmentedPath() };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

export function cliText(cli: string, args: string[], environment: Record<string, string | undefined> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execCli(cli, args, {
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      env: childEnvironment(environment),
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** One short-lived JSON-line exchange. No prompt or inference turn is sent. */
export function cliJsonLines(
  cli: string,
  args: string[],
  first: unknown,
  accept: (message: any, send: (message: unknown) => void) => ModelCatalog | null,
  environment: Record<string, string | undefined> = {},
): Promise<ModelCatalog> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(cli, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(environment),
    });
    let done = false;
    let buffer = "";
    let stderr = "";
    const finish = (value?: ModelCatalog, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killCliTree(child);
      if (value) resolve(value);
      else reject(error ?? new Error("model discovery ended without a catalog"));
    };
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    const timer = setTimeout(() => finish(undefined, new Error("model discovery timed out")), DISCOVERY_TIMEOUT_MS);
    child.on("error", (error) => finish(undefined, error));
    child.on("close", (code) => finish(undefined, new Error(`model discovery exited ${code}${stderr ? `: ${stderr.slice(-200)}` : ""}`)));
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-1000); });
    child.stdout.on("data", (data) => {
      buffer += data;
      if (buffer.length > MAX_OUTPUT) return finish(undefined, new Error("model discovery response too large"));
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        try {
          const result = accept(message, send);
          if (result) return finish(result);
        } catch (error) {
          return finish(undefined, error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    send(first);
  });
}

export function discoverClaudeModels(cli: string): Promise<ModelCatalog> {
  return cliJsonLines(
    cli,
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { type: "control_request", request_id: "gbs-models", request: { subtype: "initialize" } },
    (message) => {
      if (message.type !== "control_response" || message.response?.request_id !== "gbs-models") return null;
      if (message.response.subtype !== "success") throw new Error("Claude rejected model discovery");
      const models: any[] = message.response.response?.models ?? [];
      return catalog(models.filter((m) => typeof m?.value === "string").map((m) => ({
        id: m.value,
        label: typeof m.displayName === "string" ? m.displayName : m.value,
      })), models.find((m) => m.value === "default")?.value);
    },
  );
}

export function discoverCodexModels(cli: string): Promise<ModelCatalog> {
  const options: Array<{ id: string; label: string }> = [];
  let preferred: string | undefined;
  let nextId = 2;
  return cliJsonLines(
    cli,
    ["app-server"],
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "gerer-build-studio", version: "1" } } },
    (message, send) => {
      if (message.id === 1) {
        if (message.error) throw new Error(message.error.message ?? "Codex initialization failed");
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: nextId, method: "model/list", params: { limit: 100 } });
      } else if (message.id === nextId) {
        if (message.error) throw new Error(message.error.message ?? "Codex model list failed");
        for (const model of message.result?.data ?? []) {
          if (model.hidden || typeof model.model !== "string") continue;
          options.push({ id: model.model, label: typeof model.displayName === "string" ? model.displayName : model.model });
          if (model.isDefault) preferred = model.model;
        }
        if (message.result?.nextCursor) {
          nextId++;
          send({ jsonrpc: "2.0", id: nextId, method: "model/list", params: { limit: 100, cursor: message.result.nextCursor } });
        } else return catalog(options, preferred);
      }
      return null;
    },
  );
}

export function parseTabModels(output: string): ModelCatalog {
  return catalog(output.split(/\r?\n/).flatMap((line) => {
    const [id, ...label] = line.trim().split("\t");
    return /^[\w.-]+$/.test(id ?? "") && label.length ? [{ id, label: label.join(" ").trim() || id }] : [];
  }));
}

export function parseGrokModels(output: string): ModelCatalog {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const preferred = clean.match(/^Default model:\s*([^\s()]+)/m)?.[1];
  const section = clean.split("Available models:")[1] ?? "";
  const options = section.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*[*-]\s+([^\s()]+)(?:\s+\(default\))?\s*$/);
    return match ? [{ id: match[1], label: match[1] }] : [];
  });
  return catalog(options, preferred);
}

export function discoverAcpModels(cli: string, args: string[], environment: Record<string, string> = {}): Promise<ModelCatalog> {
  return cliJsonLines(
    cli,
    args,
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } },
    (message, send) => {
      if (message.id === 1) {
        if (message.error) throw new Error(message.error.message ?? "ACP initialization failed");
        send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
      } else if (message.id === 2) {
        if (message.error) throw new Error(message.error.message ?? "ACP session discovery failed");
        const state = message.result?.models ?? message.result?._meta?.modelState;
        const available = Array.isArray(state?.availableModels) ? state.availableModels : [];
        if (available.length) return catalog(available.filter((m: any) => typeof m?.modelId === "string").map((m: any) => ({
          id: m.modelId,
          label: typeof m.name === "string" ? m.name : m.modelId,
        })), state?.currentModelId);
        const config = (message.result?.configOptions ?? []).find((o: any) => o.category === "model" || o.id === "model");
        if (Array.isArray(config?.options)) return catalog(config.options.filter((o: any) => typeof o?.value === "string").map((o: any) => ({
          id: o.value,
          label: typeof o.name === "string" ? o.name : o.value,
        })), config.currentValue);
        throw new Error("ACP agent did not advertise selectable models");
      }
      return null;
    },
    environment,
  );
}
