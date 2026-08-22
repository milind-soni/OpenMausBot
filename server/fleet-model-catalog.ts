// Guarded AOS fleet-model projection for OpenMausBot.
//
// This adapter reads one versioned, secret-free file. It never discovers
// providers, talks to model hosts, or reads credential stores. The producer
// owns live admission; OpenMausBot only renders its cached verdict and maps a
// stable canonical id to the native id understood by a concrete driver.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { ModelOption, ModelRuntimeStatus } from "./contracts.ts";
import { parseJson, schemaIssue } from "./schema.ts";

const AOS_DATA_HOME = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
export const DEFAULT_AOS_MODEL_CATALOG_PATH = join(
  AOS_DATA_HOME,
  "aos-model-catalog",
  "current",
  "openmausbot-models.v1.json",
);

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9._:/+-]{0,191}$/i;
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const FORBIDDEN_SECRET_VALUE = /^(?:Bearer\s+\S{12,}|sk-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})$/;

const stableIdSchema = z.string()
  .regex(ID, "must be a stable model id")
  .refine((value) => !FORBIDDEN_SECRET_VALUE.test(value), "must not contain a credential value");
const secretFreeTextSchema = z.string().trim().min(1).max(4_096).refine(
  (value) => !FORBIDDEN_SECRET_VALUE.test(value),
  "must not contain a credential value",
);
const capabilitySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,47}$/);
const capabilitiesSchema = z.array(capabilitySchema).refine(
  (values) => new Set(values).size === values.length,
  "must not contain duplicate capabilities",
);
const runtimeStatusSchema = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  verified: z.boolean(),
  admitted: z.boolean(),
  busy: z.boolean(),
  reason: secretFreeTextSchema.nullable(),
  last_verification_receipt: secretFreeTextSchema.nullable(),
}).strict();
const translationsSchema = z.object({
  litellm: stableIdSchema.nullable(),
  hermes: stableIdSchema.nullable(),
  opencode: stableIdSchema.nullable(),
  telegram: stableIdSchema.nullable(),
  openmausbot: stableIdSchema.nullable(),
}).strict();
const modelRowSchema = z.object({
  id: stableIdSchema,
  display_name: secretFreeTextSchema.max(160),
  kind: z.enum(["model", "route_group"]),
  provider_id: stableIdSchema,
  native_model_id: secretFreeTextSchema.max(512).nullable(),
  capabilities: capabilitiesSchema,
  host: z.enum(["hosted", "mac", "windows"]),
  cost_class: z.enum(["paid_subscription", "paid_metered", "free", "local"]),
  manual_only: z.boolean(),
  is_default: z.boolean(),
  selectable: z.boolean(),
  status: runtimeStatusSchema,
  translations: translationsSchema,
  route_members: z.array(stableIdSchema).refine(
    (members) => new Set(members).size === members.length,
    "must not contain duplicate route members",
  ),
}).strict().superRefine((model, context) => {
  if (model.selectable && (
    !model.status.configured ||
    !model.status.reachable ||
    !model.status.verified ||
    !model.status.admitted ||
    model.status.busy ||
    !model.capabilities.includes("chat")
  )) {
    context.addIssue({
      code: "custom",
      path: ["selectable"],
      message: "selectable contradicts runtime admission gates or chat capability",
    });
  }
  if (model.kind === "model" && model.route_members.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["route_members"],
      message: "a concrete model cannot have route members",
    });
  }
});
const providerCandidateSchema = z.object({
  provider_id: stableIdSchema,
  display_name: secretFreeTextSchema.max(160),
  configured: z.boolean(),
  selectable: z.boolean().refine((selectable) => !selectable, {
    message: "must remain false without an exact model identity",
  }),
  reason: z.literal("unverified_provider_or_model"),
}).strict();
const catalogProjectionSchema = z.object({
  schema_version: z.literal("openmausbot-models/v1"),
  catalog_version: z.number().int().positive(),
  generated_at: z.string().refine(
    (value) => RFC3339.test(value) && !Number.isNaN(Date.parse(value)),
    "must be RFC3339",
  ),
  source: z.object({
    registry_schema_version: secretFreeTextSchema.max(160),
    registry_version: z.number().int().positive(),
    registry_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }).strict(),
  default_model_id: stableIdSchema,
  provider_candidates: z.array(providerCandidateSchema),
  models: z.array(modelRowSchema),
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  for (const [index, model] of catalog.models.entries()) {
    if (ids.has(model.id)) {
      context.addIssue({
        code: "custom",
        path: ["models", index, "id"],
        message: `duplicate canonical model id "${model.id}"`,
      });
    }
    ids.add(model.id);
  }
  const providerIds = new Set<string>();
  for (const [index, candidate] of catalog.provider_candidates.entries()) {
    if (providerIds.has(candidate.provider_id)) {
      context.addIssue({
        code: "custom",
        path: ["provider_candidates", index, "provider_id"],
        message: `duplicate provider candidate "${candidate.provider_id}"`,
      });
    }
    providerIds.add(candidate.provider_id);
  }
  if (!ids.has(catalog.default_model_id)) {
    context.addIssue({
      code: "custom",
      path: ["default_model_id"],
      message: "is absent from models",
    });
  }
  const defaults = catalog.models.filter((model) => model.is_default);
  if (defaults.length !== 1 || defaults[0]?.id !== catalog.default_model_id) {
    context.addIssue({
      code: "custom",
      path: ["default_model_id"],
      message: "and the single is_default row must agree",
    });
  }
  for (const [index, model] of catalog.models.entries()) {
    for (const member of model.route_members) {
      if (!ids.has(member)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "route_members"],
          message: `route member "${member}" is absent from models`,
        });
      }
    }
  }
});
const sharedDefaultSchema = z.object({
  schema_version: z.literal("aos-model-default/v1"),
  canonical_model_id: stableIdSchema,
  catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  registry_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  applies_to_new_sessions_only: z.literal(true),
  active_sessions_rewritten: z.literal(false),
}).strict();

export type FleetCatalogState = "ready" | "missing" | "invalid";

export interface FleetModelTranslation {
  driverKind: string;
  modelId: string;
  instanceId?: string;
}

export interface FleetModelRecord {
  canonicalId: string;
  label: string;
  kind: "model" | "route_group";
  nativeModelId: string | null;
  provider: string;
  host: "hosted" | "mac" | "windows";
  costClass: "paid_subscription" | "paid_metered" | "free" | "local";
  capabilities: string[];
  status: ModelRuntimeStatus;
  reason?: string;
  default: boolean;
  manualOnly: boolean;
  declaredSelectable: boolean;
  verificationReceipt?: string;
  translations: FleetModelTranslation[];
  routeMembers: string[];
}

export interface FleetProviderCandidate {
  providerId: string;
  label: string;
  configured: boolean;
  selectable: false;
  reason: string;
}

export interface FleetModelCatalogSnapshot {
  schema: "openmausbot-models/v1";
  source: {
    path: string;
    state: FleetCatalogState;
    refreshedAt: string;
    generatedAt?: string;
    catalogVersion?: number;
    registrySchemaVersion?: string;
    registryVersion?: number;
    registrySha256?: string;
    defaultModelId?: string;
    defaultState?: "catalog" | "shared" | "invalid";
    defaultReason?: string;
    reason?: string;
  };
  models: FleetModelRecord[];
  providerCandidates: FleetProviderCandidate[];
}

export interface ParsedFleetModelCatalog {
  generatedAt: string;
  catalogVersion: number;
  registrySchemaVersion: string;
  registryVersion: number;
  registrySha256: string;
  models: FleetModelRecord[];
  providerCandidates: FleetProviderCandidate[];
}

interface InstanceDescription {
  instanceId: string;
  driverKind: string;
  models: { default: string; options: ModelOption[] };
  snapshot?: { state: string; reason?: string };
}

function modelTranslations(model: z.output<typeof modelRowSchema>): FleetModelTranslation[] {
  const translations: FleetModelTranslation[] = [];
  if (model.translations.hermes) {
    translations.push({ driverKind: "hermesAgent", modelId: model.translations.hermes });
  }
  if (model.translations.opencode) {
    translations.push({ driverKind: "opencodeGo", modelId: model.translations.opencode });
  }
  if ((model.host === "mac" || model.host === "windows") && model.translations.openmausbot) {
    translations.push({
      driverKind: "local",
      modelId: model.translations.openmausbot,
      instanceId: model.host === "mac" ? "localMac" : "localWindows",
    });
  }
  return translations;
}

export function parseFleetModelCatalog(raw: string): ParsedFleetModelCatalog {
  if (Buffer.byteLength(raw, "utf8") > MAX_CATALOG_BYTES) throw new Error("catalog exceeds 2 MiB");
  let json;
  try {
    json = parseJson(raw);
  } catch {
    throw new Error("catalog is not valid JSON");
  }
  const parsed = catalogProjectionSchema.safeParse(json);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "catalog is invalid"));
  const catalog = parsed.data;
  const models = catalog.models.map((model): FleetModelRecord => {
    const record: FleetModelRecord = {
      canonicalId: model.id,
      label: model.display_name,
      kind: model.kind,
      nativeModelId: model.native_model_id,
      provider: model.provider_id,
      host: model.host,
      costClass: model.cost_class,
      capabilities: [...model.capabilities],
      status: {
        configured: model.status.configured,
        reachable: model.status.reachable,
        verified: model.status.verified,
        admitted: model.status.admitted,
        busy: model.status.busy,
      },
      default: model.is_default,
      manualOnly: model.manual_only,
      declaredSelectable: model.selectable,
      translations: modelTranslations(model),
      routeMembers: [...model.route_members],
    };
    if (model.status.reason) record.reason = model.status.reason;
    if (model.status.last_verification_receipt) {
      record.verificationReceipt = model.status.last_verification_receipt;
    }
    return record;
  });
  return {
    generatedAt: catalog.generated_at,
    catalogVersion: catalog.catalog_version,
    registrySchemaVersion: catalog.source.registry_schema_version,
    registryVersion: catalog.source.registry_version,
    registrySha256: catalog.source.registry_sha256,
    models,
    providerCandidates: catalog.provider_candidates.map((candidate) => ({
      providerId: candidate.provider_id,
      label: candidate.display_name,
      configured: candidate.configured,
      selectable: false,
      reason: candidate.reason,
    })),
  };
}

function failedModels(previous: readonly FleetModelRecord[], reason: string): FleetModelRecord[] {
  return previous.map((model) => ({
    ...model,
    status: { ...model.status, admitted: false },
    reason,
  }));
}

export class FleetModelCatalogRegistry {
  readonly path: string;
  readonly defaultPath: string;
  private cached: FleetModelCatalogSnapshot;

  constructor(
    path = process.env.AOS_MODEL_CATALOG_PATH?.trim() || DEFAULT_AOS_MODEL_CATALOG_PATH,
    defaultPath = process.env.AOS_MODEL_DEFAULT_PATH?.trim() || join(dirname(path), "default-model.v1.json"),
  ) {
    this.path = path;
    this.defaultPath = defaultPath;
    this.cached = {
      schema: "openmausbot-models/v1",
      source: { path, state: "missing", refreshedAt: new Date().toISOString(), reason: "catalog not loaded" },
      models: [],
      providerCandidates: [],
    };
    this.refresh();
  }

  snapshot(): FleetModelCatalogSnapshot {
    return structuredClone(this.cached);
  }

  refresh(): FleetModelCatalogSnapshot {
    const refreshedAt = new Date().toISOString();
    try {
      const size = statSync(this.path).size;
      if (size > MAX_CATALOG_BYTES) throw new Error("catalog exceeds 2 MiB");
      const raw = readFileSync(this.path, "utf8");
      const parsed = parseFleetModelCatalog(raw);
      const catalogSha256 = createHash("sha256").update(raw).digest("hex");
      let defaultState: "catalog" | "shared" | "invalid" = "catalog";
      let defaultReason: string | undefined;
      try {
        const shared = sharedDefaultSchema.parse(
          parseJson(readFileSync(this.defaultPath, "utf8")),
        );
        if (shared.registry_sha256 !== parsed.registrySha256) {
          throw new Error("shared default registry hash is stale");
        }
        if (shared.catalog_sha256 !== catalogSha256) {
          throw new Error("shared default catalog hash is stale");
        }
        const selected = parsed.models.find(
          (model) => model.canonicalId === shared.canonical_model_id,
        );
        if (!selected) throw new Error("shared default canonical model is unknown");
        const unavailable = unavailability(selected);
        if (unavailable) throw new Error(`shared default is unavailable: ${unavailable}`);
        for (const model of parsed.models) {
          model.default = model.canonicalId === shared.canonical_model_id;
        }
        defaultState = "shared";
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          defaultState = "invalid";
          defaultReason = error instanceof Error ? error.message : "shared default is invalid";
        }
      }
      const defaultModelId = parsed.models.find((model) => model.default)?.canonicalId;
      const source: FleetModelCatalogSnapshot["source"] = {
        path: this.path,
        state: "ready",
        refreshedAt,
        generatedAt: parsed.generatedAt,
        catalogVersion: parsed.catalogVersion,
        registrySchemaVersion: parsed.registrySchemaVersion,
        registryVersion: parsed.registryVersion,
        registrySha256: parsed.registrySha256,
        defaultModelId,
        defaultState,
      };
      if (defaultReason) source.defaultReason = defaultReason;
      this.cached = {
        schema: "openmausbot-models/v1",
        source,
        models: parsed.models,
        providerCandidates: parsed.providerCandidates,
      };
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      const reason = missing ? "catalog file is missing" : error instanceof Error ? error.message : "catalog is invalid";
      this.cached = {
        schema: "openmausbot-models/v1",
        source: {
          path: this.path,
          state: missing ? "missing" : "invalid",
          refreshedAt,
          reason,
        },
        models: failedModels(this.cached.models, reason),
        providerCandidates: this.cached.providerCandidates.map((candidate) => ({ ...candidate, reason })),
      };
    }
    return this.snapshot();
  }
}

function unavailability(model: FleetModelRecord): string | undefined {
  if (!model.capabilities.includes("chat")) return model.reason ?? "Not chat-capable";
  if (model.status.busy) return model.reason ?? "Host is busy";
  if (!model.status.configured) return model.reason ?? "Not configured";
  if (!model.status.reachable) return model.reason ?? "Host is unreachable";
  if (!model.status.verified) return model.reason ?? "Not verified";
  if (!model.status.admitted) return model.reason ?? "Not admitted";
  if (!model.declaredSelectable) return model.reason ?? "Not currently selectable";
  return undefined;
}

function optionFor(model: FleetModelRecord, nativeId: string): ModelOption {
  const reason = unavailability(model);
  const option: ModelOption = {
    id: nativeId,
    label: model.label,
    custom: true,
    canonicalId: model.canonicalId,
    provider: model.provider,
    host: model.host,
    costClass: model.costClass,
    manualOnly: model.manualOnly,
    isDefault: model.default,
    capabilities: [...model.capabilities],
    status: { ...model.status },
    selectable: reason === undefined,
  };
  if (reason) option.reason = reason;
  if (model.verificationReceipt) option.verificationReceipt = model.verificationReceipt;
  return option;
}

/** Merge driver-native projections into model-picker rows without changing
 * the live driver catalog or probing any provider. */
export function projectFleetModels<T extends InstanceDescription>(
  instances: readonly T[],
  catalog: FleetModelCatalogSnapshot,
): T[] {
  const projectedCanonicalIds = new Set<string>();
  const ownsCustomInventory = catalog.source.state === "ready" ||
    catalog.models.length > 0 || catalog.providerCandidates.length > 0;
  const projected = instances.map((instance) => {
    // Once a guarded catalog exists, it is the only owner of Custom rows.
    // Raw local discovery cannot re-admit an unclassified embedding model or
    // a machine that the producer marked busy/unreachable. A non-AOS install
    // with no catalog keeps the product's historical custom-model behavior.
    const options = instance.models.options
      .filter((option) => !ownsCustomInventory || !option.custom)
      .map((option) => ({ ...option }));
    let defaultId = options.some((option) => option.id === instance.models.default)
      ? instance.models.default
      : options[0]?.id ?? "";
    for (const model of catalog.models) {
      const translations = model.translations.filter((translation) =>
        translation.driverKind === instance.driverKind &&
        (!translation.instanceId || translation.instanceId === instance.instanceId)
      );
      for (const translation of translations) {
        projectedCanonicalIds.add(model.canonicalId);
        const projectedOption = optionFor(model, translation.modelId);
        const existing = options.findIndex((option) => option.id === projectedOption.id);
        if (existing >= 0) options[existing] = { ...options[existing], ...projectedOption };
        else options.push(projectedOption);
        if (model.default && projectedOption.selectable) defaultId = projectedOption.id;
      }
    }
    return {
      ...instance,
      models: { default: defaultId, options },
    };
  });

  // Unsupported candidates still belong in the inventory. Put each one on a
  // single preferred fleet rail as a disabled row instead of silently
  // dropping it or inventing a driver translation that could execute it.
  const inventoryTarget =
    projected.find((instance) => instance.driverKind === "hermesAgent") ??
    projected.find((instance) => instance.driverKind === "opencodeGo") ??
    projected[0];
  if (inventoryTarget) {
    for (const model of catalog.models) {
      if (projectedCanonicalIds.has(model.canonicalId)) continue;
      const inventory = optionFor(model, model.canonicalId);
      inventory.selectable = false;
      inventory.reason = model.reason ?? "Unavailable on this OpenMausBot surface";
      if (!inventoryTarget.models.options.some((option) => option.canonicalId === model.canonicalId)) {
        inventoryTarget.models.options.push(inventory);
      }
    }
    for (const candidate of catalog.providerCandidates) {
      const canonicalId = `provider-candidate:${candidate.providerId}`;
      if (inventoryTarget.models.options.some((option) => option.canonicalId === canonicalId)) continue;
      inventoryTarget.models.options.push({
        id: canonicalId,
        label: candidate.label,
        custom: true,
        canonicalId,
        provider: candidate.providerId,
        host: "hosted",
        costClass: "unknown",
        manualOnly: true,
        isDefault: false,
        capabilities: [],
        status: {
          configured: candidate.configured,
          reachable: false,
          verified: false,
          admitted: false,
          busy: false,
        },
        selectable: false,
        reason: candidate.reason,
      });
    }
  }
  return projected;
}
