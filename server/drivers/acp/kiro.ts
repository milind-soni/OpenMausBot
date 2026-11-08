// Kiro CLI 3.1.0 over ACP (`kiro-cli acp --agent-engine=v3 --auth-method=cli`)
// Verified against kiro-cli 3.1.0 (build 5acd3b9, 2026-11-05) and T3 provider-kiro:
//   - initialize -> protocolVersion 1, authMethods [{id:"aws-builder-id"},{id:"aws-iam-identity-center"}]
//     or [{id:"kiro-login"}] before bundle update; promptCapabilities.image false
//   - session/new advertises configOptions: model (category "model"), effortLevel (category "thought_level"),
//     autopilot (on/off), mode (agent selector), plus _kiro/config/template agent list
//   - model and effortLevel are set with session/set_config_option, which answers with full configOptions
//   - autopilot session option controls Supervised vs Autopilot; sessions start "on", T3 sets it from runtime mode
//   - clientCapabilities._meta {kiro:{hooks:{enabled:true,v2:true}}} keeps V3 hooks server-side
//   - V2 flags (--agent-engine v2, --v2) are invalid on V3; model/effort must be set per session, not argv
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";
import { harnessHome } from "../../env-path.ts";

const AGENT_DEFAULT = { id: "agent-default", label: "Kiro default" };
const MODELS: ModelCatalog = { default: AGENT_DEFAULT.id, options: [AGENT_DEFAULT] };
const SPAWN_ARGS = ["acp", "--agent-engine=v3", "--auth-method=cli"] as const;
const LOGIN_NOTE = "Kiro is not signed in. Run `kiro-cli login` in a terminal, then check again.";
const AUTH_IDS = new Set(["aws-builder-id", "aws-iam-identity-center", "kiro-login"]);
const FALLBACK_MODEL = "auto";

/** Kiro's SQLite auth store, honoring XDG_DATA_HOME per XDG spec. */
function kiroDataDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "kiro-cli");
  return join(harnessHome("kiro-cli", env));
}

/** Kiro's per-user agent config dir, honoring KIRO_HOME. */
function kiroHome(env: Record<string, string | undefined>): string {
  return env.KIRO_HOME?.trim() ? String(env.KIRO_HOME) : join(env.HOME || homedir(), ".kiro");
}

/** Whether the Kiro CLI appears signed in for this env (heuristic probe, not cryptographic validation). */
export function kiroSignedIn(env: Record<string, string | undefined>): boolean {
  if (env.KIRO_API_KEY?.trim()) return true;
  if (env.AWS_BEARER_TOKEN_KIRO?.trim()) return true;
  try {
    const db = join(kiroDataDir(env), "data.sqlite3");
    if (existsSync(db)) {
      try {
        if (statSync(db).size > 100) return true;
      } catch {
        // stat failed — fall through to legacy check
      }
    }
    if (existsSync(join(kiroHome(env), "config.json"))) return true;
  } catch {
    // probe failed — treat as not signed in
  }
  return false;
}

const DISCOVERY: AcpDiscoveryOptions = {
  passthrough: AGENT_DEFAULT,
  custom: false,
  variants: true,
  // Kiro's hooks must remain server-side; otherwise _kiro/hooks/* requests would reach the client
  clientCapabilitiesMeta: { kiro: { hooks: { enabled: true, v2: true } } },
  exitGraceMs: 1_000,
  label: (model) => model.label,
};

/** Live model catalog via ACP discovery with Kiro V3 hooks kept server-side. */
export function resolveKiroModels(
  env: Record<string, string | undefined>,
  config: { cli: string },
): Promise<ModelCatalog> {
  return discoverAcpModels(env, config.cli, [...SPAWN_ARGS] as string[], DISCOVERY);
}

/** Prefer Builder ID over IAM Identity Center for Kiro's advertised auth methods. */
function pickKiroAuthMethod(methods: Array<{ id: string }>): string | null {
  // Prefer AWS Builder ID over IAM Identity Center; kiro-login is the fallback name in older bundles
  const ids = new Set(methods.map((m) => String(m.id)));
  if (ids.has("aws-builder-id")) return "aws-builder-id";
  if (ids.has("aws-iam-identity-center")) return "aws-iam-identity-center";
  if (ids.has("kiro-login")) return "kiro-login";
  for (const id of ids) if (AUTH_IDS.has(id)) return id;
  return null;
}

const SUPPORT: AcpSupport = {
  driverKind: "kiroAgent",
  displayName: "Kiro",
  models: MODELS,
  defaultCli: "kiro-cli",
  nativeSource: "kiro.acp",
  images: false,
  loginNote: LOGIN_NOTE,
  install: {
    command: { darwin: "curl -fsSL https://cli.kiro.dev/install | bash", linux: "curl -fsSL https://cli.kiro.dev/install | bash", win32: "winget install KiroCLI" },
    docsUrl: "https://kiro.dev/docs/cli/setup/",
    signInCommand: "kiro-cli login",
  },
  spawnArgs: () => [...SPAWN_ARGS] as string[],
  credentialEnv: ["KIRO_API_KEY"],
  clientCapabilitiesMeta: { kiro: { hooks: { enabled: true, v2: true } } },
  sessionMeta: (config) => config.fullAuto ? { kiro: { policyPreset: ["allow-all"] } } : null,
  resolveModels: (env, config) => resolveKiroModels(env, config as { cli: string }),
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id, allowLegacy: true },
  modelVariants: true,
  ownedModelOptionIds: new Set(["model", "effortLevel", "autopilot", "mode"]),
  fallbackModel: (_sessionConfig, catalogDefault) => {
    // "Kiro default" leaves native session unchanged; fall back to auto when catalog default is missing
    if (!catalogDefault || catalogDefault === AGENT_DEFAULT.id) return FALLBACK_MODEL;
    return catalogDefault;
  },
  pickAuthMethod: (methods) => pickKiroAuthMethod(methods as Array<{ id: string }>),
  authFailure: "continue",
  isAuthenticated: (env) => kiroSignedIn(env),
  sessionScopedApproval: true,
  async configureSession({ request, sessionId, config }) {
    // Full access uses Kiro V3 allow-all preset (sessionMeta) plus autopilot on. Ask uses no preset and autopilot off.
    const value = config.fullAuto ? "on" : "off";
    try {
      await request("session/set_config_option", { sessionId, configId: "autopilot", value });
    } catch (error) {
      throw new Error(`Kiro rejected permission mode "${value}": ${(error as Error).message}`);
    }
  },
  // Tool events, streaming, cancellation, MCP/workspace/computer are handled by core's ACP runtime
  // Kiro-specific post-filters (fetch_cloud_config tool noise, [STEERING] user echo) are dropped in core's
  // session/update handler when driverKind is kiroAgent; see core.ts kiro update guard.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KiroAgentDriver = createAcpDriver(SUPPORT);
