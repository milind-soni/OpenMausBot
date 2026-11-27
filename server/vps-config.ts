/** The self-hosted VPS settings: the default SSH alias (`vps`) and the named servers (`vpsServers`). */
import { z } from "zod";

import { DEFAULT_DESKTOP_RESOURCES, MAX_DESKTOP_CPUS, MAX_DESKTOP_MEMORY_GB, MIN_DESKTOP_CPUS, MIN_DESKTOP_MEMORY_GB, type DesktopResources } from "./container-limits.ts";

export const vpsIdleConfigSchema = z.object({ timeoutMinutes: z.number().int().min(5).max(1_440).optional() }).strict();

export function vpsIdleTimeoutMinutes(cfg: { vpsIdle?: z.infer<typeof vpsIdleConfigSchema> }): number {
  return cfg.vpsIdle?.timeoutMinutes ?? 480;
}

const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** What each bot's VPS desktop may use on the default server. */
export function vpsResources(cfg: { vps?: VpsConfig }): DesktopResources {
  return {
    memoryGb: cfg.vps?.memoryGb ?? DEFAULT_DESKTOP_RESOURCES.memoryGb,
    cpus: cfg.vps?.cpus ?? DEFAULT_DESKTOP_RESOURCES.cpus,
  };
}

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

/** A named host from the user's SSH config; authentication stays with SSH. `memoryGb` (no swap beyond it, 4 when unset) and `cpus` (2 when unset) cap each bot's VPS desktop; a running desktop takes a change when it is next provisioned or started. */
export type VpsConfig = { sshAlias?: string; memoryGb?: number; cpus?: number };

/** The alias is replaced by every save (left out, it is cleared); a limit the patch leaves out keeps its stored value. */
export function normalizeVpsConfig(raw: unknown, stored?: unknown): VpsConfig {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vps must be an object containing an SSH config alias");
  }
  const patch = raw as Record<string, unknown>;
  const kept = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const out: VpsConfig = {};
  const alias = patch.sshAlias;
  if (alias !== undefined && alias !== "") {
    if (!isValidSshAlias(alias)) {
      throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
    }
    out.sshAlias = alias;
  }
  for (const [key, min, max] of [["memoryGb", MIN_DESKTOP_MEMORY_GB, MAX_DESKTOP_MEMORY_GB], ["cpus", MIN_DESKTOP_CPUS, MAX_DESKTOP_CPUS]] as const) {
    const value = key in patch ? patch[key] : kept[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`vps.${key} must be a whole number from ${min} to ${max}`);
    }
    out[key] = value;
  }
  return out;
}

const memoryGbSchema = z.number().int().min(MIN_DESKTOP_MEMORY_GB).max(MAX_DESKTOP_MEMORY_GB);
const cpusSchema = z.number().int().min(MIN_DESKTOP_CPUS).max(MAX_DESKTOP_CPUS);
export const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), { message: "must be a simple SSH config alias" }).optional(),
  memoryGb: memoryGbSchema.optional(),
  cpus: cpusSchema.optional(),
});
export const MAX_VPS_SERVERS = 20;
/** `memoryGb` and `cpus` cap this server's desktops; a limit left out is the default server's (`vps`). */
export interface VpsServer { name: string; sshAlias: string; memoryGb?: number; cpus?: number }
export const vpsServerSchema = z.object({
  name: z.string().trim().min(1).max(60).refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), { message: "must be plain text" }),
  sshAlias: z.string().refine(isValidSshAlias, { message: "must be a simple SSH config alias" }),
  memoryGb: memoryGbSchema.optional(),
  cpus: cpusSchema.optional(),
});
/** Named servers a bot can be put on; the default server stays in `vps`, so saving this list never moves a bot. */
export const vpsServersSchema = z.array(vpsServerSchema).max(MAX_VPS_SERVERS)
  .refine((servers) => new Set(servers.map((server) => server.sshAlias)).size === servers.length, { message: "each server needs its own SSH alias" });
/** Loose: a hand-edited bad or repeated entry is dropped, never the whole file. */
export const storedVpsServersSchema = z.unknown().optional().transform((servers) => {
  if (!Array.isArray(servers)) return undefined;
  const seen = new Set<string>();
  return servers.flatMap((server) => {
    const parsed = vpsServerSchema.safeParse(server);
    return parsed.success && !seen.has(parsed.data.sshAlias) && seen.add(parsed.data.sshAlias) ? [parsed.data] : [];
  }).slice(0, MAX_VPS_SERVERS);
});
