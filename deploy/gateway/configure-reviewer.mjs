import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function reviewerCatalog(bundled) {
  // Use the standard Responses tool schema. The newer code-mode-only
  // catalog entries require Responses Lite, which this gateway does not expose.
  const baseline = bundled.models.find((model) => model.slug === "gpt-5.5");
  if (!baseline || baseline.use_responses_lite || baseline.tool_mode) {
    throw new Error("Codex's standard Responses model metadata is unavailable.");
  }
  return { models: ["azure-gpt", "gemini-3.8-flash", "bedrock-claude"].map((slug) => ({
    ...baseline,
    slug,
    display_name: slug,
    description: "OpenMaus gateway route",
    // Keep Codex's automatic reviewer and policy. Only its inference route
    // changes; Azure's configured GPT deployment reviews every provider.
    auto_review_model_override: "azure-gpt",
  })) };
}

export function configureReviewer(codexHome, bundled) {
  const catalogPath = join(resolve(codexHome), "openmaus-models.json");
  const configPath = join(resolve(codexHome), "config.toml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const setting = `model_catalog_json = ${JSON.stringify(catalogPath)}`;
  const existing = current.match(/^model_catalog_json\s*=.*$/m)?.[0];
  if (existing && existing !== setting) throw new Error("An existing model catalog is configured; merge it explicitly before continuing.");
  const catalog = reviewerCatalog(bundled);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), { mode: 0o600 });
  if (!existing) {
    if (current) writeFileSync(`${configPath}.before-openmaus-reviewer-${Date.now()}`, current, { flag: "wx", mode: 0o600 });
    writeFileSync(configPath, `${setting}\n${current}`, { mode: 0o600 });
  }
  return catalogPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, codexHome, ...extra] = process.argv.slice(2);
  if (flag !== "--codex-home" || !codexHome || extra.length) throw new Error("Usage: node configure-reviewer.mjs --codex-home /data/.codex");
  const bundled = JSON.parse(execFileSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8" }));
  console.log(`Configured Azure GPT automatic reviewer: ${configureReviewer(codexHome, bundled)}`);
}
