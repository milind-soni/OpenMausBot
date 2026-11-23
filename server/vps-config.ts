/** The self-hosted VPS settings: the default SSH alias (`vps`) and the named servers (`vpsServers`). */
import { z } from "zod";

const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

export function normalizeVpsConfig(raw: unknown): { sshAlias?: string } {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vps must be an object containing an SSH config alias");
  }
  const alias = (raw as Record<string, unknown>).sshAlias;
  if (alias === undefined || alias === "") return {};
  if (!isValidSshAlias(alias)) {
    throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
  }
  return { sshAlias: alias };
}

export const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), { message: "must be a simple SSH config alias" }).optional(),
});
export const MAX_VPS_SERVERS = 20;
export interface VpsServer { name: string; sshAlias: string }
export const vpsServerSchema = z.object({
  name: z.string().trim().min(1).max(60).refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), { message: "must be plain text" }),
  sshAlias: z.string().refine(isValidSshAlias, { message: "must be a simple SSH config alias" }),
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
