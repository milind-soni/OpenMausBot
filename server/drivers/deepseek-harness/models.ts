import { z } from "zod";

import type { EffortLevel, ModelCatalog } from "../../contracts.ts";
import type { DshJsonValue } from "./protocol.ts";

const text = z.string().min(1).max(512);
const dshEffortIdSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const dshEffortSchema = z.object({ id: text, name: text, description: z.string().max(2_000).optional() });
const dshModelSchema = z.object({
  id: text,
  name: text,
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  reasoning: z.object({ efforts: z.array(dshEffortSchema).max(16) }).optional(),
});
const dshGroupSchema = z.object({ id: text, name: text, models: z.array(dshModelSchema).max(1_000) });
const dshFailureSchema = z.object({ id: text, name: text, message: z.string().min(1).max(500) });
const dshCatalogEnvelopeSchema = z.object({ groups: z.array(z.unknown()).max(256), failures: z.array(z.unknown()).max(256) });

export interface DshModelCatalogResult {
  catalog: ModelCatalog | null;
  diagnostics: string[];
}

const EFFORT_MAP = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const satisfies Readonly<Record<string, EffortLevel>>;

export function encodeDshModelId(provider: string, model: string): string {
  return `dsh:${Buffer.from(provider, "utf8").toString("base64url")}:${Buffer.from(model, "utf8").toString("base64url")}`;
}

export function decodeDshModelId(value: string): { provider: string; model: string } | null {
  const parts = /^dsh:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(value);
  if (!parts) return null;
  try {
    const provider = Buffer.from(parts[1], "base64url").toString("utf8");
    const model = Buffer.from(parts[2], "base64url").toString("utf8");
    return provider && model && encodeDshModelId(provider, model) === value ? { provider, model } : null;
  } catch {
    return null;
  }
}

export function mapDshEffortLevels(efforts: readonly string[]): EffortLevel[] {
  const mapped: EffortLevel[] = [];
  for (const effort of efforts) {
    const parsed = dshEffortIdSchema.safeParse(effort);
    if (!parsed.success) continue;
    const level = EFFORT_MAP[parsed.data];
    if (level && !mapped.includes(level)) mapped.push(level);
  }
  return mapped;
}

export function flattenDshModelCatalog(value: DshJsonValue): DshModelCatalogResult {
  const envelope = dshCatalogEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { catalog: null, diagnostics: ["DSH model catalog was invalid"] };
  const diagnostics: string[] = [];
  const options: ModelCatalog["options"] = [];
  for (const failure of envelope.data.failures) {
    const parsed = dshFailureSchema.safeParse(failure);
    if (parsed.success) diagnostics.push(`${parsed.data.name}: ${parsed.data.message}`);
  }
  for (const groupValue of envelope.data.groups) {
    const group = dshGroupSchema.safeParse(groupValue);
    if (!group.success) {
      diagnostics.push("DSH provider catalog entry was invalid");
      continue;
    }
    for (const model of group.data.models) {
      const effortLevels = mapDshEffortLevels(model.reasoning?.efforts.map((effort) => effort.id) ?? []);
      const option: ModelCatalog["options"][number] = {
        id: encodeDshModelId(group.data.id, model.id),
        label: `${group.data.name}: ${model.name}`,
      };
      if (model.contextWindow) option.contextWindow = model.contextWindow;
      if (effortLevels.length) option.effortLevels = effortLevels;
      options.push(option);
    }
  }
  return options.length
    ? { catalog: { default: options[0].id, options }, diagnostics: [] }
    : { catalog: null, diagnostics };
}
