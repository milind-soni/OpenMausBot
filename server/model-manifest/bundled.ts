// The bundled manifest, importable before anything else in the server: the drivers build their fixed lists from it at load.
import type { ModelCatalog } from "../contracts.ts";
import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import { parseModelManifest, type ManifestEngine, type ModelManifestData } from "./schema.ts";

const parsedBundle = parseModelManifest(bundledManifestJson, { strict: true, nowMs: Number.MAX_SAFE_INTEGER / 2 });
if (!parsedBundle.ok) throw new Error(`The bundled model manifest is invalid (${parsedBundle.error})`);
export const BUNDLED_MODEL_MANIFEST: ModelManifestData = parsedBundle.manifest;

/** The manifest's engine as the picker wants it; legacy models stay valid in a saved bot but are not offered for new picks. */
export function engineCatalogFrom(manifest: ModelManifestData, engine: ManifestEngine): ModelCatalog | null {
  const section = manifest.engines[engine];
  if (!section) return null;
  return {
    default: section.default,
    options: section.models.filter((model) => model.status === "current").map((model) => ({
      id: model.id,
      label: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.variants?.length ? { variants: model.variants } : {}),
    })),
  };
}

export function bundledEngineCatalog(engine: ManifestEngine): ModelCatalog {
  return engineCatalogFrom(BUNDLED_MODEL_MANIFEST, engine)!;
}

