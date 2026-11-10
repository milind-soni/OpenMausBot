import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { BUNDLED_MODEL_MANIFEST } from "./bundled.ts";
import { modelManifestCachePath } from "./manifest.ts";

// The store is one per process and the drivers read it as they load, so its cache is seeded before they are imported,
// as a later start of the app would find it.
const newer = new Date(Date.now() + 60_000).toISOString();
const path = modelManifestCachePath(DATA_DIR);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify({
  fetchedAtMs: Date.now(),
  manifest: {
    version: 1,
    updatedAt: newer,
    engines: {
      claude: {
        default: "claude-sonnet-5",
        models: [
          { id: "claude-synthetic-9", name: "Claude Synthetic 9", status: "current", contextWindow: 1_000_000, minCliVersion: "9.9.9" },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", status: "current" },
        ],
      },
    },
    prices: { "claude-synthetic-9": { inputPerMillion: 7, outputPerMillion: 9, asOf: "2026-11-10", source: "https://platform.claude.com/x" } },
  },
}));

const [{ officialModels }, { readClaudeModelCatalog, STATIC_CLAUDE_MODELS }, { readGrokModelCatalog }, { withOrgBlocks }, { listPriceFor }, { readStartupModelCache, writeStartupModelCache }] = await Promise.all([
  import("../agent-endpoint-models.ts"),
  import("../drivers/claude.ts"),
  import("../drivers/acp/grok.ts"),
  import("../drivers/claude-model-access.ts"),
  import("../model-prices.ts"),
  import("../startup-model-catalog.ts"),
]);

it("a list on disk reaches the picker, the official-endpoint list and the price table", () => {
  const catalog = readClaudeModelCatalog({ HOME: "/nonexistent-home" });
  expect(catalog.options.map((option) => option.id)).toEqual(["claude-synthetic-9", "claude-sonnet-5"]);
  expect(catalog.options[0]).toMatchObject({ contextWindow: 1_000_000 });
  expect(catalog.default).toBe("claude-sonnet-5");
  expect(officialModels(false)).toContain("claude-synthetic-9");
  expect(listPriceFor("claude-synthetic-9")).toMatchObject({ inputPerMillion: 7, outputPerMillion: 9 });
});

it("leaves the bundled list and the org blocks working", () => {
  expect(STATIC_CLAUDE_MODELS.options.some((option) => option.id === "claude-synthetic-9")).toBe(false);
  const catalog = readClaudeModelCatalog({ HOME: "/nonexistent-home" });
  const blocked = withOrgBlocks(catalog, new Set(["claude-sonnet-5"]));
  expect(blocked.options.find((option) => option.id === "claude-sonnet-5")?.orgBlocked).toBe(true);
});

it("an engine the download left out keeps its bundled list", () => {
  const bundled = BUNDLED_MODEL_MANIFEST.engines.grok!.models.map((model) => model.id);
  expect(readGrokModelCatalog({ HOME: "/nonexistent-home" }).options.map((option) => option.id)).toEqual(bundled);
});

it("the startup list keeps a model's update mark", () => {
  const id = "manifest-wiring";
  writeStartupModelCache(id, { default: "a", options: [{ id: "a", label: "A", needsCliUpdate: "2.1.321" }] });
  expect(readStartupModelCache(id)?.options[0]?.needsCliUpdate).toBe("2.1.321");
});
