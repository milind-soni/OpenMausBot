import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { suggestRoleOverlays } from "./role-overlays.ts";

/** One canonical declaration shared by host inventory and runtime dispatch. */
export const FLEET_CAPABILITY_TOOL_DEFINITIONS = [
  {
    name: "search_capabilities",
    description: "Search the metadata-only fleet index for MCPs, skills, scripts, and other capabilities without loading their schemas or instructions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        surface: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 25 },
      },
    },
  },
  {
    name: "suggest_capabilities",
    description: "Suggest a small task-relevant set of fleet capability metadata and advisory role overlays.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 25 } },
      required: ["task"],
    },
  },
  {
    name: "select_capability",
    description: "Select one exact fleet capability and return its safe lazy route, if this runtime can verify one.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "suggest_role_overlays",
    description: "Suggest non-privileged portfolio specialist roles for the current task.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 5 } },
      required: ["task"],
    },
  },
] as const;

const DEFAULT_INDEX = join(
  homedir(),
  ".local",
  "share",
  "aos-session-bridge",
  "current",
  "runtime",
  "capabilities.v1.json",
);
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_RESULTS = 25;
const SAFE_KIND = /^[a-z][a-z0-9._-]{0,63}$/i;
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.credvault|Keychains?|Cookies?|Passwords?)(?:[\\/]|$)/i;

interface RawCapabilityRecord {
  id?: unknown;
  kind?: unknown;
  owner?: unknown;
  configured?: unknown;
  authenticated?: unknown;
  reachable?: unknown;
  output_verified?: unknown;
  compatible_surfaces?: unknown;
  enabled_surfaces?: unknown;
  last_verified?: unknown;
  source_path?: unknown;
  command_path?: unknown;
}

interface RawCapabilityCatalog {
  schema?: unknown;
  generated_at?: unknown;
  record_count?: unknown;
  records?: unknown;
}

export interface FleetCapabilityMetadata {
  id: string;
  kind: string;
  owner: string | null;
  configured: boolean | null;
  authenticated: boolean | null;
  reachable: boolean | null;
  outputVerified: boolean;
  compatibleSurfaces: string[];
  enabledSurfaces: string[];
  lastVerified: string | null;
}

interface LoadedCatalog {
  path: string;
  ino: number;
  ctimeMs: number;
  mtimeMs: number;
  size: number;
  schema: string;
  generatedAt: string | null;
  catalogSha256: string;
  records: Array<{ metadata: FleetCapabilityMetadata; raw: RawCapabilityRecord }>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 160))].sort();
}

function triState(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function metadata(raw: RawCapabilityRecord): FleetCapabilityMetadata | null {
  const id = boundedText(raw.id, 300);
  const kind = boundedText(raw.kind, 64);
  if (!id || !kind || !SAFE_KIND.test(kind)) return null;
  return {
    id,
    kind,
    owner: boundedText(raw.owner, 160),
    configured: triState(raw.configured),
    authenticated: triState(raw.authenticated),
    reachable: triState(raw.reachable),
    outputVerified: raw.output_verified === true,
    compatibleSurfaces: stringList(raw.compatible_surfaces),
    enabledSurfaces: stringList(raw.enabled_surfaces),
    lastVerified: boundedText(raw.last_verified, 80),
  };
}

function queryTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9.+#/-]+/).filter((token) => token.length > 1))];
}

function recordScore(record: FleetCapabilityMetadata, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 1;
  const haystack = [record.id, record.kind, record.owner, ...record.compatibleSurfaces, ...record.enabledSurfaces]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  let score = haystack.includes(normalized) ? 12 : 0;
  for (const token of queryTokens(normalized)) {
    if (record.id.toLowerCase() === token) score += 10;
    else if (record.id.toLowerCase().includes(token)) score += 5;
    else if (haystack.includes(token)) score += 2;
  }
  if (record.outputVerified) score += 1;
  if (record.reachable === true) score += 1;
  return score;
}

function selectedPath(record: RawCapabilityRecord): string | null {
  const candidate = [record.command_path, record.source_path].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!candidate || !isAbsolute(candidate) || candidate.includes("\0")) return null;
  const path = resolve(candidate);
  if (SENSITIVE_PATH.test(path)) return null;
  try {
    const info = statSync(path);
    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}

export class FleetCapabilityIndex {
  private readonly path: string;
  private loaded: LoadedCatalog | null = null;

  constructor(path = process.env.OMB_FLEET_CAPABILITIES_PATH || DEFAULT_INDEX) {
    this.path = resolve(path);
  }

  private catalog(): LoadedCatalog {
    let info;
    try {
      info = statSync(this.path);
    } catch {
      throw new Error("fleet capability index is unavailable or oversized");
    }
    if (!info.isFile() || info.size <= 0 || info.size > MAX_INDEX_BYTES) {
      throw new Error("fleet capability index is unavailable or oversized");
    }
    if (this.loaded && this.loaded.ino === info.ino && this.loaded.ctimeMs === info.ctimeMs &&
      this.loaded.mtimeMs === info.mtimeMs && this.loaded.size === info.size) return this.loaded;
    const rawBytes = readFileSync(this.path);
    const parsed = JSON.parse(rawBytes.toString("utf8")) as RawCapabilityCatalog;
    if (parsed.schema !== "capabilities.v1" || !Array.isArray(parsed.records)) {
      throw new Error("fleet capability index schema is not supported");
    }
    const records = parsed.records.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const raw = value as RawCapabilityRecord;
      const normalized = metadata(raw);
      return normalized ? [{ metadata: normalized, raw }] : [];
    });
    this.loaded = {
      path: this.path,
      ino: info.ino,
      ctimeMs: info.ctimeMs,
      mtimeMs: info.mtimeMs,
      size: info.size,
      schema: "capabilities.v1",
      generatedAt: boundedText(parsed.generated_at, 80),
      catalogSha256: createHash("sha256").update(rawBytes).digest("hex"),
      records,
    };
    return this.loaded;
  }

  summary(): {
    schema: string;
    generatedAt: string | null;
    catalogSha256: string;
    recordCount: number;
    kinds: Record<string, number>;
    policy: "metadata-only-and-task-lazy";
  } {
    const catalog = this.catalog();
    const kinds: Record<string, number> = {};
    for (const { metadata: record } of catalog.records) kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
    return {
      schema: catalog.schema,
      generatedAt: catalog.generatedAt,
      catalogSha256: catalog.catalogSha256,
      recordCount: catalog.records.length,
      kinds: Object.fromEntries(Object.entries(kinds).sort(([left], [right]) => left.localeCompare(right))),
      policy: "metadata-only-and-task-lazy",
    };
  }

  search(input: { query?: string; kind?: string; surface?: string; limit?: number } = {}): FleetCapabilityMetadata[] {
    const query = String(input.query ?? "").slice(0, 500);
    const kind = String(input.kind ?? "").trim().toLowerCase();
    const surface = String(input.surface ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 10, 1), MAX_RESULTS);
    return this.catalog().records
      .map(({ metadata: record }, index) => ({
        record,
        index,
        score: recordScore(record, query),
      }))
      .filter(({ record, score }) =>
        score > 0 &&
        (!kind || record.kind.toLowerCase() === kind) &&
        (!surface || record.compatibleSurfaces.map((value) => value.toLowerCase()).includes(surface)),
      )
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit)
      .map(({ record }) => record);
  }

  suggest(task: string, limit = 10): {
    capabilities: FleetCapabilityMetadata[];
    roleOverlays: ReturnType<typeof suggestRoleOverlays>;
  } {
    return {
      capabilities: this.search({ query: task, limit }),
      roleOverlays: suggestRoleOverlays(task),
    };
  }

  select(id: string, availableServers: readonly string[]): {
    capability: FleetCapabilityMetadata;
    status: "ready" | "metadata-only";
    route: Record<string, unknown>;
  } {
    const selected = this.catalog().records.find(({ metadata: record }) => record.id === id);
    if (!selected) throw new Error("unknown fleet capability id");
    const { metadata: capability, raw } = selected;
    if (capability.kind === "mcp") {
      const sourceName = capability.id.replace(/^mcp:/i, "");
      const serverNames = availableServers
        .filter((name) => name === sourceName || name.startsWith(`${sourceName}-`))
        .sort();
      return {
        capability,
        status: serverNames.length ? "ready" : "metadata-only",
        route: serverNames.length
          ? { kind: "mcp", serverNames, next: "list the selected server tools, then call only the task-relevant tool" }
          : { kind: "mcp", next: "known to the fleet but not mounted in this OpenMausBot runtime" },
      };
    }
    if (capability.kind === "skill" || capability.kind === "script") {
      const path = selectedPath(raw);
      return {
        capability,
        status: path ? "ready" : "metadata-only",
        route: path
          ? capability.kind === "skill"
            ? { kind: "skill", instructionPath: path, next: "read the complete SKILL.md before taking task actions" }
            : { kind: "script", commandPath: path, next: "inspect help and safety contract before invoking" }
          : { kind: capability.kind, next: "metadata exists but no safe current file path was verified" },
      };
    }
    return {
      capability,
      status: "metadata-only",
      route: { kind: capability.kind, next: "use this record for discovery; no executable route is mounted" },
    };
  }
}
