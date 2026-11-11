import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MANIFEST_PATH, manifestProblems } from "./check-model-manifest.mjs";

const committed = readFileSync(MANIFEST_PATH, "utf8");
const doc = () => JSON.parse(committed);
const problems = (value) => manifestProblems(JSON.stringify(value, null, 2));

describe("the committed model manifest", () => {
  it("passes the strict check and keeps the required models", () => {
    expect(manifestProblems(committed)).toEqual([]);
    const fable = doc().engines.claude.models.find((model) => model.id === "claude-fable-5-2");
    expect(fable).toMatchObject({ contextWindow: 1_000_000, minCliVersion: "2.1.321" });
    expect(doc().engines.claude.default).toBe("claude-sonnet-5");
    expect(doc().prices["claude-fable-5-2"]).toMatchObject({ inputPerMillion: 8, cachedInputPerMillion: 0.2, outputPerMillion: 40 });
  });
});

describe("what the CI check refuses", () => {
  const withModel = (patch) => {
    const manifest = doc();
    manifest.engines.claude.models.push({ id: "synthetic-model", name: "Synthetic", status: "current", ...patch });
    return manifest;
  };

  it("malformed JSON", () => {
    expect(manifestProblems("{ not json")).toEqual(["the manifest is not valid JSON"]);
  });

  it("a model id the engine would not accept", () => {
    expect(problems(withModel({ id: "--dangerously-skip-permissions" }))[0]).toMatch(/models/);
    expect(problems(withModel({ id: "model; rm -rf /" }))[0]).toMatch(/models/);
    expect(problems(withModel({ id: "default" }))[0]).toMatch(/reserved/);
    expect(problems(withModel({ id: "x".repeat(200) }))[0]).toMatch(/models/);
  });

  it("a missing required field, a bad status or a CLI floor that is not a version", () => {
    const missing = doc();
    delete missing.engines.claude.models[0].status;
    expect(problems(missing)[0]).toMatch(/status/);
    expect(problems(withModel({ status: "preview" }))[0]).toMatch(/status/);
    expect(problems(withModel({ minCliVersion: "latest" }))[0]).toMatch(/minCliVersion/);
  });

  it("an unknown field, which the check treats as a typo", () => {
    expect(problems(withModel({ contextWindw: 1 }))[0]).toMatch(/contextWindw/);
  });

  it("a default that is not a listed current model", () => {
    const manifest = doc();
    manifest.engines.claude.default = "not-listed-model";
    expect(problems(manifest)[0]).toMatch(/default/);
  });

  it("a duplicate id or an alias that repeats one", () => {
    const manifest = withModel({ id: "claude-sonnet-5" });
    expect(problems(manifest)[0]).toMatch(/listed twice/);
    expect(problems(withModel({ aliases: ["claude-sonnet-5"] }))[0]).toMatch(/listed twice/);
  });

  it("a missing engine", () => {
    const manifest = doc();
    delete manifest.engines.grok;
    expect(problems(manifest).length).toBeGreaterThan(0);
  });

  it("a future updatedAt, which would pin every install to it", () => {
    const manifest = doc();
    manifest.updatedAt = "2099-01-01T00:00:00Z";
    expect(problems(manifest)[0]).toMatch(/future/);
  });

  it("a price that is not a number, negative or absurd", () => {
    const manifest = doc();
    manifest.prices["claude-sonnet-5"].inputPerMillion = "2";
    expect(problems(manifest)[0]).toMatch(/inputPerMillion/);
    manifest.prices["claude-sonnet-5"].inputPerMillion = -1;
    expect(problems(manifest)[0]).toMatch(/inputPerMillion/);
    manifest.prices["claude-sonnet-5"].inputPerMillion = 2_000_000;
    expect(problems(manifest)[0]).toMatch(/inputPerMillion/);
  });

  it("an edit whose updatedAt did not move forward", () => {
    const edited = doc();
    edited.engines.claude.models[1].name = "Edited name";
    expect(manifestProblems(JSON.stringify(edited), { previous: committed })[0]).toMatch(/updatedAt/);
    const bumped = { ...edited, updatedAt: new Date(Date.parse(doc().updatedAt) + 1000).toISOString() };
    expect(manifestProblems(JSON.stringify(bumped), { previous: committed })).toEqual([]);
    expect(manifestProblems(committed, { previous: committed })).toEqual([]);
  });
});
