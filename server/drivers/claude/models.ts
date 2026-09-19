// Claude driver config shape and model catalog: the static cloud list, the
// per-turn inject-id resolution, and the settings.json extras. Split out of
// drivers/claude.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, probeLocalInjects, resolveInjectId } from "../local-inject.ts";
import { resolveClaudeConfigDir } from "./env-auth.ts";

export const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  /** Separate CLI-managed login/settings. Empty uses the normal CLI account. */
  configDir?: string;
  /** Company routing is supplied by the private desktop parent, never local discovery. */
  managed?: boolean;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  /** Available Claude built-ins. An empty list passes `--tools ""`. */
  tools?: string[];
  /** Claude tool patterns to deny after the available set is selected. */
  disallowedTools?: string[];
}

// model catalog ported from upstream packages/contracts/src/model.ts
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** Rewrite a leftover API slug (`orcarouter/Qwen…`) to `host::model` when a
 *  local host is serving it, so the turn injects instead of asking for /login.
 *  Official cloud ids and already-encoded inject ids skip the probe. */
export async function resolveClaudeTurnModel(
  model: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null | undefined> {
  if (!model || decodeInjectId(model) || STATIC_CLAUDE_MODELS.options.some((option) => option.id === model)) {
    return model;
  }
  return resolveInjectId(model, await probeLocalInjects(env)) ?? model;
}

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return CLAUDE_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; slug?: unknown; name?: unknown; displayName?: unknown; label?: unknown };
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !CLAUDE_MODEL_ID.test(id)) return [];
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => typeof candidate === "string");
    return [{ id, label: label || id }];
  });
}

/** Extra ids from ~/.claude/settings.json. Official cloud rows stay untagged.
 *  `model` is Claude Code's last-used slug, not a catalog — listing it as
 *  Custom put a non-inject id in the picker and the turn then had no
 *  ANTHROPIC_API_KEY ("Not logged in · Please run /login"). Live injects
 *  come from mergeLocalInject. */
export function readClaudeModelCatalog(env: Record<string, string | undefined> = process.env) {
  // A missing or unreadable settings.json is not fatal: an instance whose
  // environment sets ANTHROPIC_MODEL (a Claude Code install pointed at an
  // Anthropic-compatible host) still lists that model as Custom.
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(resolveClaudeConfigDir(undefined, env), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }

  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]));

  const options = STATIC_CLAUDE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_CLAUDE_MODELS.default, options };
}
