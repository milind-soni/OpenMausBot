// Box naming — deterministic installation-scoped names, durable legacy
// pre-scope names, and the name-shape regexes inventory trusts.

import { createHash } from "node:crypto";

import { DATA_DIR } from "../config.ts";
import { loadEnvironmentId } from "../environment.ts";

export const LEGACY_MANAGED_BOX_NAME = /^ogb-[a-z0-9]{1,8}-[a-f0-9]{6}$/;
export const SCOPED_MANAGED_BOX_NAME = /^ogb-[a-f0-9]{12}-[a-z0-9]{1,8}-[a-f0-9]{6}$/;

// Provider listings are account-wide. Hash the durable local environment id
// into every new name so another OpenMausBot installation using the same Box
// account cannot mistake this installation's computers for abandoned ones.
// The environment UUID itself never leaves the local data directory.
let scopedBoxPrefixCache: string | null = null;

/** Resolve only after server startup has migrated the legacy data directory
 * and acquired its writer lease. A static-import side effect here used to
 * create the new directory too early and suppress that migration. */
export function scopedBoxPrefix(): string {
  if (scopedBoxPrefixCache) return scopedBoxPrefixCache;
  const scope = createHash("sha256")
    .update(loadEnvironmentId(DATA_DIR))
    .digest("hex")
    .slice(0, 12);
  scopedBoxPrefixCache = `ogb-${scope}-`;
  return scopedBoxPrefixCache;
}

function boxBotNameParts(botId: string): { prefix: string; hash: string } {
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "") || "bot";
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  return { prefix, hash };
}

export function legacyBoxNameFor(botId: string): string {
  const { prefix, hash } = boxBotNameParts(botId);
  return `ogb-${prefix}-${hash}`;
}

// Deterministic per installation and bot. The bot hash kills truncated-id
// collisions; the environment scope prevents cross-install ownership claims.
export async function boxNameFor(botId: string) {
  const { prefix, hash } = boxBotNameParts(botId);
  return `${scopedBoxPrefix()}${prefix}-${hash}`;
}

/** Credential restoration must accept both current installation-scoped names
 * and durable pre-scope names that the ownership journal may have adopted. */
export async function boxNameMatchesBot(botId: string, name: string): Promise<boolean> {
  return name === await boxNameFor(botId) || name === legacyBoxNameFor(botId);
}
