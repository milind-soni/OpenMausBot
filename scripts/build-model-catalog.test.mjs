import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { LICENSE_PATH, MAX_GZIP_BYTES, SNAPSHOT_PATH, buildCatalogDocument, serializeCatalog, snapshotProblems, toLf } from "./build-model-catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// As checked out: CRLF in a Windows working tree written before .gitattributes pinned it.
const committed = readFileSync(SNAPSHOT_PATH, "utf8");
const licenseText = toLf(readFileSync(LICENSE_PATH, "utf8"));
const raw = {
  good: {
    id: "good", name: "Good", env: ["GOOD_API_KEY"], api: "https://api.good.example/v1/", doc: "https://good.example",
    models: {
      "m-1": { id: "m-1", name: "M 1", tool_call: true, reasoning: false, attachment: false, modalities: { input: ["text"] }, cost: { input: 1, output: 2, cache_read: 0.1 } },
      "m-{env:OMB_MP_KEY_OTHER}": { id: "m-{env:OMB_MP_KEY_OTHER}", name: "x", tool_call: true, modalities: { input: ["text"] } },
    },
  },
  templated: { id: "templated", name: "T", env: [], api: "https://${ACCOUNT}.example/v1", models: {} },
};

describe("model catalog snapshot", () => {
  it("is sound as committed: trimmed, brace-free, formatted, licensed and within budget", () => {
    expect(snapshotProblems(committed)).toEqual([]);
    expect(gzipSync(toLf(committed)).length).toBeLessThanOrEqual(MAX_GZIP_BYTES);
    const doc = JSON.parse(committed);
    expect(doc.source).toMatchObject({ name: "models.dev", commit: "7f91a155297c92203cc1111dac7f0ca42d478f22", license: "MIT", licenseText });
  });

  it("is checked out with LF on every platform", () => {
    // Windows CI checks text out as CRLF unless .gitattributes says otherwise,
    // and the snapshot and its licence text are compared byte for byte.
    const paths = ["server/model-catalog/models-dev.snapshot.json", "third_party/models-dev/LICENSE", "third_party/opencode/LICENSE"];
    const attrs = execFileSync("git", ["check-attr", "eol", "--", ...paths], { cwd: root, encoding: "utf8" });
    expect(attrs.trim().split(/\r?\n/)).toEqual(paths.map((path) => `${path}: eol: lf`));
  });

  it("still passes when the working tree has CRLF line endings", () => {
    const crlf = toLf(committed).replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(toLf(committed));
    expect(snapshotProblems(crlf)).toEqual([]);
  });

  it("flags a brace or a hand edit", () => {
    const tampered = committed.replace('"name":"OpenRouter"', '"name":"OpenRouter {env:HOME}"');
    expect(tampered).not.toBe(committed);
    expect(snapshotProblems(tampered)).toContain("a provider or model contains { or }");
    expect(snapshotProblems(committed.replace("\n", ""))).toContain("formatting differs from the build script's output; rebuild the snapshot");
  });
});

describe("buildCatalogDocument", () => {
  it("trims, drops braces, reports each drop and round-trips through the serializer", () => {
    const drops = [];
    const doc = buildCatalogDocument(raw, { commit: "7f91a15", updatedAt: "2026-09-30T05:32:26Z", licenseText, onDrop: (drop) => drops.push(drop) });
    expect(Object.keys(doc.providers)).toEqual(["good"]);
    expect(doc.providers.good.api).toBe("https://api.good.example/v1");
    expect(doc.providers.good.models).toEqual({ "m-1": { name: "M 1", reasoning: false, attachment: false, modalities: { input: ["text"] }, cost: { input: 1, output: 2 } } });
    expect(drops).toEqual([
      { provider: "good", model: "m-{env:OMB_MP_KEY_OTHER}", reason: "brace" },
      { provider: "templated", reason: "brace" },
    ]);
    const text = serializeCatalog(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(snapshotProblems(text)).toEqual([]);
  });

  it("insists on provenance", () => {
    expect(() => buildCatalogDocument(raw, { commit: "main", updatedAt: "2026-09-30T05:32:26Z" })).toThrow(/commit/);
    expect(() => buildCatalogDocument(raw, { commit: "7f91a15", updatedAt: "yesterday" })).toThrow(/updated-at/);
    expect(() => buildCatalogDocument({}, { commit: "7f91a15", updatedAt: "2026-09-30T05:32:26Z" })).toThrow(/no usable providers/);
  });
});
