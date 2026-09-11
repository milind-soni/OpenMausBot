// Qwen Code — Alibaba's `qwen --acp` CLI. Custom-only in OpenMausBot:
// the official pane has no Qwen Cloud catalog; live local hosts land in
// Custom and are written into ~/.qwen/settings.json modelProviders.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };

function qwenHome(env: Record<string, string | undefined>): string {
  const home = process.platform === "win32"
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || env.USERPROFILE || homedir();
  return join(home, ".qwen");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function qwenModelLabel(id: string, name: string): string {
  if (!name || name.toLocaleLowerCase().endsWith(id.toLocaleLowerCase())) return id;
  return `${id} — ${name}`;
}

type QwenRoute = { id: string; model: string; label: string; provider: string; protocol: string; baseUrl?: string; envKey?: string };
const PROTOCOLS = new Set(["openai", "anthropic", "gemini", "vertex-ai"]);

function readQwenRoutes(env: Record<string, string | undefined>): QwenRoute[] {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(qwenHome(env), "settings.json"), "utf8")) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(settings) || !isRecord(settings.modelProviders)) return [];

  const routes: QwenRoute[] = [];
  const seen = new Set<string>();
  const mappings = isRecord(settings.providerProtocol) ? settings.providerProtocol : {};
  for (const [provider, rows] of Object.entries(settings.modelProviders)) {
    const protocol = Object.hasOwn(mappings, provider) ? mappings[provider] : provider;
    if (typeof protocol !== "string" || !PROTOCOLS.has(protocol) || !Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "string") continue;
      const model = row.id;
      if (!model.trim()) continue;
      if (row.baseUrl !== undefined && typeof row.baseUrl !== "string") continue;
      const baseUrl = typeof row.baseUrl === "string" && row.baseUrl ? row.baseUrl : undefined;
      if (baseUrl) {
        try { new URL(baseUrl); }
        catch { throw new Error("A Qwen model has an invalid endpoint. Fix its baseUrl in Qwen settings and refresh models."); }
      }
      const identity = JSON.stringify([protocol, model, baseUrl ?? null]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (row.imageOnly === true || row.voiceOnly === true || row.fastOnly === true) continue;
      routes.push({ id: `${model}(${protocol})`, model, provider, protocol, baseUrl,
        label: typeof row.name === "string" && row.name ? row.name : model,
        envKey: typeof row.envKey === "string" ? row.envKey : undefined });
    }
  }
  // Qwen's ACP route identity, from QwenLM/qwen-code acpModelUtils.ts
  // (Copyright 2025 Qwen Team, Apache-2.0). Never publish endpoints or env keys.
  const counts = new Map<string, number>();
  for (const route of routes) counts.set(route.id, (counts.get(route.id) ?? 0) + 1);
  for (const route of routes) {
    if (counts.get(route.id) === 1) continue;
    const endpoint = route.baseUrl ?? (route.protocol === "openai" ? "https://api.openai.com/v1" : "");
    let publicEndpoint: string | null = null;
    if (endpoint) {
      try {
        const url = new URL(endpoint);
        url.username = ""; url.password = ""; url.search = ""; url.hash = "";
        publicEndpoint = url.href;
      } catch { throw new Error("A Qwen model has an invalid endpoint. Fix its baseUrl in Qwen settings and refresh models."); }
    }
    const identity = [route.id, route.label, route.envKey ?? null, route.baseUrl === undefined, publicEndpoint];
    route.id = `qwen-route:v1:${createHash("sha256").update(JSON.stringify(identity)).digest("base64url").slice(0, 16)}`;
  }
  if (new Set(routes.map((route) => route.id)).size !== routes.length) {
    throw new Error("Qwen has indistinguishable model routes. Give them distinct names, envKey values, or public endpoints in Qwen settings.");
  }
  return routes;
}

/** Public metadata only. Use Qwen's provider-qualified ACP selectors, not raw model IDs. */
export function readQwenModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const options = readQwenRoutes(env).map(({ id, model, label, provider }) => ({
    id, label: qwenModelLabel(model, label), custom: true as const, provider,
  }));
  return { default: options[0]?.id ?? "", options };
}

function envKeyFor(hostId: string): string {
  return `OPENMAUSBOT_QWEN_${hostId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Upsert an OpenAI-compatible provider row so `qwen -m` can reach the host. */
export function ensureQwenInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const dir = qwenHome(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed user config — inject into a fresh object rather than fail the turn.
    }
  }
  const keyName = envKeyFor(inject.host);
  const key = hostApiKey(host, env);
  const envMap =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? { ...(settings.env as Record<string, unknown>) }
      : {};
  envMap[keyName] = key;
  settings.env = envMap;

  const providers =
    settings.modelProviders && typeof settings.modelProviders === "object" && !Array.isArray(settings.modelProviders)
      ? { ...(settings.modelProviders as Record<string, unknown>) }
      : {};
  const openai = Array.isArray(providers.openai) ? [...providers.openai] : [];
  const match = openai.find(
    (row) =>
      row &&
      typeof row === "object" &&
      (row as { id?: unknown }).id === inject.model &&
      (row as { baseUrl?: unknown }).baseUrl === host.baseUrl,
  );
  if (!match) {
    openai.push({
      id: inject.model,
      name: `${inject.model} (${host.label})`,
      baseUrl: host.baseUrl,
      envKey: keyName,
    });
    providers.openai = openai;
    settings.modelProviders = providers;
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; keep the inject even if chmod is unsupported.
  }
  return inject.model;
}

async function resolveModels(env: Record<string, string | undefined>): Promise<ModelCatalog> {
  const catalog = await mergeLocalInject(readQwenModelCatalog(env), env);
  const routes = readQwenRoutes(env);
  const replacements = new Map<string, string>();
  for (const option of catalog.options) {
    const injected = decodeInjectId(option.id);
    if (!injected) continue;
    const endpoint = localHost(injected.host)?.baseUrl;
    for (const route of routes) {
      if (route.protocol === "openai" && route.model === injected.model && route.baseUrl === endpoint) {
        replacements.set(route.id, option.id);
      }
    }
  }
  const options = catalog.options.filter((option) => !replacements.has(option.id));
  const preferred = replacements.get(catalog.default) ?? catalog.default;
  return { default: options.some((option) => option.id === preferred) ? preferred : options[0]?.id ?? "", options };
}

export function resolveQwenTurnModel(model: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!model) return model;
  const injected = decodeInjectId(model);
  if (injected) ensureQwenInjectModel(model, env);
  const routes = readQwenRoutes(env);
  if (injected) {
    const route = routes.find((row) => row.protocol === "openai" && row.model === injected.model
      && row.baseUrl === localHost(injected.host)?.baseUrl);
    if (!route) throw new Error("Qwen could not configure this local model. Refresh models and select it again.");
    return route.id;
  }
  if (routes.some((route) => route.id === model)) return model;
  const matches = routes.filter((route) => route.model === model);
  if (matches.length > 1) throw new Error("This Qwen model has multiple providers. Refresh models and select the intended provider again.");
  if (!matches.length) throw new Error("This Qwen model is no longer configured. Refresh models and select it again.");
  return matches[0].id;
}

const support: AcpSupport = {
  driverKind: "qwenAgent",
  displayName: "Qwen",
  access: "custom",
  models: EMPTY,
  resolveModels,
  resolveTurnModel: resolveQwenTurnModel,
  defaultCli: "qwen",
  nativeSource: "qwen.acp",
  loginNote: "Qwen Code CLI is not installed",
  install: {
    command: {
      darwin: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      linux: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      win32: "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
    },
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/overview/",
  },
  // A raw -m only changes the model within the saved provider. ACP switches
  // the complete route and confirms it before any prompt leaves OMB.
  spawnArgs: () => ["--acp"],
  selectModel: { configId: "model" },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const QwenAgentDriver = createAcpDriver(support);
