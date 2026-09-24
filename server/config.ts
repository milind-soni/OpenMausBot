// Config + data dirs. One file, ~/.gbs/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ck_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
// `instances.<id>` entries are hand-editable but also written by the app
// itself (e.g. the Settings permission toggle), via saveConfig's per-id merge.
import { mkdirSync } from "node:fs";
import { readJsonFile, restrictToOwner, writeJsonAtomic } from "./json-file.ts";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceConfigMap } from "./contracts.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** key = ck_… Connect consumer key (connections + agent tools);
   * apiKey = ak_… project API key — optional, unlocks the full toolkit
   * catalog with official logos in the plugins marketplace. */
  composio?: { key?: string; apiKey?: string; url?: string };
  box?: { token?: string };
  /** key = a Trello Power-Up API key (identifies this app, not secret);
   * token = the connected user's personal Trello token, obtained through
   * Trello's own browser authorize flow. Powers per-project board linking
   * and sync in trello.ts / trelloLinks.ts / trelloSync.ts. */
  trello?: { key?: string; token?: string };
  /** The person using the app (collected in onboarding, shown in the
   * sidebar). Not a secret — echoed back by GET /api/config. */
  profile?: { name?: string; email?: string };
  /** Global setting for automatic bot-to-bot handoffs across multi-agent rooms. Defaults to true. */
  autoHandoffs?: boolean;
  /** UI-side idle approval of permission cards; questions are never automatic. */
  autoApprovePermissions?: boolean;
  autoApproveDelaySeconds?: number;
  instances?: InstanceConfigMap;
}

// GBS_DATA_DIR isolates test/soak rigs from the user's real fleet. The dir
// itself stays short (".gbs", not ".gerer-build-studio") — it's joined with
// per-turn unix socket names (server/procs.ts) and a long path here can push
// those past the 104-byte sockaddr_un limit on macOS.
export const DATA_DIR = process.env.GBS_DATA_DIR ?? join(homedir(), ".gbs");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): AppConfig {
  const p = join(DATA_DIR, "config.json");
  // holds API keys — older builds wrote it world-readable
  restrictToOwner(p);
  // first run (or a corrupt file, which is kept aside) — env fallbacks below
  const cfg = readJsonFile<AppConfig>(p, {});
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.trello = { key: process.env.TRELLO_API_KEY, ...cfg.trello };
  cfg.autoHandoffs = cfg.autoHandoffs ?? true;
  cfg.autoApprovePermissions = typeof cfg.autoApprovePermissions === "boolean" ? cfg.autoApprovePermissions : true;
  const approvalDelay = cfg.autoApproveDelaySeconds;
  cfg.autoApproveDelaySeconds = typeof approvalDelay === "number" && Number.isInteger(approvalDelay) && approvalDelay >= 1 && approvalDelay <= 120
    ? approvalDelay : 10;
  return cfg;
}

/** Merge a partial config into ~/.gbs/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  const disk = readJsonFile<Record<string, unknown>>(p, {});
  for (const key of ["xai", "composio", "box", "trello", "profile"] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  if (typeof patch.autoHandoffs === "boolean") {
    disk.autoHandoffs = patch.autoHandoffs;
  }
  if (typeof patch.autoApprovePermissions === "boolean") disk.autoApprovePermissions = patch.autoApprovePermissions;
  if (Number.isInteger(patch.autoApproveDelaySeconds) && patch.autoApproveDelaySeconds! >= 1 && patch.autoApproveDelaySeconds! <= 120) {
    disk.autoApproveDelaySeconds = patch.autoApproveDelaySeconds;
  }
  if (patch.instances && typeof patch.instances === "object") {
    const diskInstances = { ...((disk.instances as InstanceConfigMap) ?? {}) };
    for (const [instanceId, instancePatch] of Object.entries(patch.instances)) {
      diskInstances[instanceId] = { ...diskInstances[instanceId], ...instancePatch };
    }
    disk.instances = diskInstances;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(p, disk);
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  //
  // Google rides `antigravityAgent` (the `agy` CLI), not `geminiAgent`:
  // Google retired Gemini CLI for the free/Pro/Ultra tiers on 2026-06-18
  // (developers.googleblog.com, "transitioning Gemini CLI to Antigravity
  // CLI"), so a default `gemini` instance could only ever show unavailable.
  // The driver stays registered for enterprise licences, which keep Gemini
  // CLI — `{"instances": {"gemini": {"driver": "geminiAgent"}}}` restores it.
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? cfg.instances
      : {
          grok: { driver: "grokAgent" },
          claude: { driver: "claudeAgent" },
          codex: { driver: "codex" },
          antigravity: { driver: "antigravityAgent" },
          computer: { driver: "boxAgent" },
        };
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...entry.environment,
    };
  }
  return map;
}
