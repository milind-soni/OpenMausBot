// Adapted from apps/server/src/provider/ModelManifest.ts and ClaudeModelManifest.ts at commit e85e0094, MIT License,
// Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: zod in place of Effect Schema,
// a flat model list with CLI floors and prices in place of capability profiles and adapter schemas.
//
// To add a model: edit model-manifest.json, bump `updatedAt`, open a PR. `scripts/check-model-manifest.mjs` runs in CI.
import { z } from "zod";

// Claude Code's `[1m]` suffix selects a model's 1M-token context.
export const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*(?:\[1m\])?$/i;

export const MANIFEST_ENGINES = ["claude", "cursor", "grok", "kimi", "antigravity"] as const;
export type ManifestEngine = (typeof MANIFEST_ENGINES)[number];

/** A model id reaches the engine's command line, so each engine keeps its own rule; a download passes the same one. */
export const ENGINE_MODEL_ID: Readonly<Record<ManifestEngine, RegExp>> = {
  claude: CLAUDE_MODEL_ID,
  cursor: /^[a-z0-9][a-z0-9._:+-]*$/i,
  grok: /^[a-z0-9][a-z0-9._-]*$/i,
  kimi: /^[a-z0-9][a-z0-9._:/-]*$/i,
  antigravity: /^[a-z0-9][a-z0-9._-]*$/i,
};

const MODEL_ID_MAX = 160;
const CLI_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const PRICE_KEY = /^[a-z0-9][a-z0-9._:/+-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VARIANT_ID = /^[a-z0-9][a-z0-9._-]*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** Allows for a slow local clock; a date past it would pin every install to that copy until the date passed. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

type ObjectOf = typeof z.object;

const label = (max: number) => z.string().min(1).max(max).refine((value) => !CONTROL.test(value), "control characters");

const pricePeriod = {
  inputPerMillion: z.number().min(0).max(100_000),
  cachedInputPerMillion: z.number().min(0).max(100_000).optional(),
  outputPerMillion: z.number().min(0).max(100_000),
};

function modelId(engine: ManifestEngine) {
  return z.string().max(MODEL_ID_MAX).regex(ENGINE_MODEL_ID[engine]).refine((id) => id !== "default", "reserved id");
}

function engineSchema(engine: ManifestEngine, objectOf: ObjectOf) {
  const model = objectOf({
    id: modelId(engine),
    name: label(120),
    aliases: z.array(modelId(engine)).max(20).optional(),
    status: z.enum(["current", "legacy"]),
    contextWindow: z.number().int().positive().max(100_000_000).optional(),
    minCliVersion: z.string().regex(CLI_VERSION).optional(),
    variants: z.array(objectOf({ id: z.string().min(1).max(40).regex(VARIANT_ID), label: label(40) })).max(20).optional(),
  });
  return objectOf({
    default: modelId(engine),
    models: z.array(model).min(1).max(200),
  }).superRefine((catalog, context) => {
    const names = new Set<string>();
    for (const entry of catalog.models) {
      for (const name of [entry.id, ...(entry.aliases ?? [])]) {
        if (names.has(name)) context.addIssue({ code: "custom", message: `${engine}: ${name} is listed twice` });
        names.add(name);
      }
    }
    const chosen = catalog.models.find((entry) => entry.id === catalog.default);
    if (chosen?.status !== "current") context.addIssue({ code: "custom", message: `${engine}: the default must be a current model` });
  });
}

const priceEntry = (objectOf: ObjectOf) => objectOf({
  ...pricePeriod,
  asOf: z.string().regex(DAY),
  source: z.string().max(300).regex(/^https:\/\//),
  changes: z.array(objectOf({ from: z.string().regex(DAY), ...pricePeriod })).max(40).optional(),
}).refine((entry) => entry.changes === undefined || entry.changes.every((change, index, all) => index === 0 || all[index - 1]!.from < change.from),
  "price changes must be in date order");

const hasNoFutureDate = (now: number) => (updatedAt: string) => Date.parse(updatedAt) <= now + FUTURE_TOLERANCE_MS;

function manifestSchema(objectOf: ObjectOf, nowMs: number) {
  return objectOf({
    version: z.literal(1),
    updatedAt: z.iso.datetime({ offset: true }).refine(hasNoFutureDate(nowMs), "updatedAt is in the future"),
    engines: objectOf({
      claude: engineSchema("claude", objectOf),
      cursor: engineSchema("cursor", objectOf).optional(),
      grok: engineSchema("grok", objectOf).optional(),
      kimi: engineSchema("kimi", objectOf).optional(),
      antigravity: engineSchema("antigravity", objectOf).optional(),
    }),
    prices: z.record(z.string().max(MODEL_ID_MAX).regex(PRICE_KEY), priceEntry(objectOf)).optional(),
  });
}

export type ModelManifestData = z.infer<ReturnType<typeof manifestSchema>>;
export type ManifestModel = NonNullable<ModelManifestData["engines"][ManifestEngine]>["models"][number];
export type ManifestPrice = NonNullable<ModelManifestData["prices"]>[string];

export type ManifestResult = { ok: true; manifest: ModelManifestData } | { ok: false; error: string };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]!;
  return `${issue.path.join(".") || "manifest"}: ${issue.message}`;
}

/** Runtime reads leave unknown fields out, so a new field on main never freezes older installs; a real problem still
 * rejects the whole copy. `strict` is for the bundled file and CI, where an unknown field is a typo. Every engine and
 * the price table are required by the CI check, not here: a download that leaves one out only falls back to the bundled
 * copy. */
export function parseModelManifest(value: unknown, options: { strict?: boolean; nowMs?: number } = {}): ManifestResult {
  const objectOf = options.strict ? (z.strictObject as unknown as ObjectOf) : z.object;
  const parsed = manifestSchema(objectOf, options.nowMs ?? Date.now()).safeParse(value);
  return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, error: firstIssue(parsed.error) };
}
