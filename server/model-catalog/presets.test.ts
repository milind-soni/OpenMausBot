import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeApiUrl } from "../cli-api-setup.ts";
import { PROVIDER_PRESETS, codexModels, codexVerdict, providerPreset, type ResponsesCheck } from "./presets.ts";
import { containsBrace, trimModelsDevCatalog, unpackCatalog } from "./trim.ts";

const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "models-dev.snapshot.json"), "utf8"));
const catalog = trimModelsDevCatalog(unpackCatalog(snapshot.providers));

describe("provider presets table", () => {
  it("registers Greenference's own token and public catalog without promising Claude or Codex support", () => {
    expect(providerPreset("greenference")).toMatchObject({ api: "https://llm.eu.greenference.com/v1",
      env: "GREENFERENCE_TOKEN", publicModels: true, doc: "https://greenference.com/dashboard/tokens" });
    expect(providerPreset("greenference")?.anthropic).toBeUndefined();
    expect(providerPreset("greenference")?.codex).toBeUndefined();
  });
  it("lists the recommended providers in the agreed order", () => {
    const recommended = PROVIDER_PRESETS.filter((preset) => preset.recommended !== undefined)
      .sort((a, b) => a.recommended! - b.recommended!);
    expect(recommended.map((preset) => preset.label)).toEqual([
      "OpenRouter", "Fireworks AI", "DeepSeek", "Cline (ClinePass)", "Cline (credits)", "Groq", "Together AI",
      "Mistral", "xAI", "Moonshot (Kimi)", "Z.ai", "MiniMax", "Cerebras",
    ]);
    expect(recommended.map((preset) => preset.recommended)).toEqual(recommended.map((_, index) => index + 1));
  });

  it("has unique ids and only safe, pinned https addresses", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(containsBrace(preset), preset.id).toBe(false);
      expect(normalizeApiUrl(preset.api)).toBe(preset.api);
      expect(preset.api.startsWith("https://")).toBe(true);
      if (preset.anthropic) expect(normalizeApiUrl(preset.anthropic.baseUrl)).toBe(preset.anthropic.baseUrl);
      for (const link of [preset.doc, preset.anthropic?.doc, preset.codex?.kind === "documented" ? preset.codex.doc : undefined]) {
        if (link) expect(new URL(link).protocol).toBe("https:");
      }
      expect(preset.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (preset.keyCheck) expect(preset.keyCheck).toMatch(/^\/[a-z/]+$/);
    }
  });

  it("points every catalog-backed preset at a provider in the bundled snapshot", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.catalogId) expect(catalog[preset.catalogId], preset.id).toBeDefined();
      else expect(preset.env, preset.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    // Cline's credits plan is not in models.dev; its ClinePass plan is.
    expect(providerPreset("cline-credits")?.catalogId).toBeUndefined();
    expect(catalog["cline-credits"]).toBeUndefined();
  });

  it("gives Claude Code the documented Anthropic-compatible endpoints", () => {
    const endpoints = Object.fromEntries(PROVIDER_PRESETS.filter((preset) => preset.anthropic).map((preset) => [preset.id, preset.anthropic!.baseUrl]));
    expect(endpoints).toEqual({
      openrouter: "https://openrouter.ai/api",
      "fireworks-ai": "https://api.fireworks.ai/inference",
      deepseek: "https://api.deepseek.com/anthropic",
      moonshotai: "https://api.moonshot.ai/anthropic",
      zai: "https://api.z.ai/api/anthropic",
      minimax: "https://api.minimax.io/anthropic",
      opencode: "https://opencode.ai/zen",
    });
    // Bearer is fixed only where the provider documents it.
    expect(providerPreset("openrouter")?.anthropic?.auth).toBe("bearer");
    expect(providerPreset("deepseek")?.anthropic?.auth).toBeUndefined();
  });

  it("documents Codex only for OpenRouter, Fireworks and OpenAI", () => {
    expect(PROVIDER_PRESETS.filter((preset) => preset.codex?.kind === "documented").map((preset) => preset.id).sort())
      .toEqual(["fireworks-ai", "openai", "openrouter"]);
  });

  it("proves OpenRouter keys through /key because its model list is public", () => {
    expect(providerPreset("openrouter")).toMatchObject({ keyCheck: "/key", publicModels: true });
    expect(providerPreset("cline-credits")).toMatchObject({ publicModels: true });
    expect(providerPreset("cline-credits")?.keyCheck).toBeUndefined();
  });
});

describe("Codex rules", () => {
  const openrouter = providerPreset("openrouter");
  const fireworks = providerPreset("fireworks-ai");
  const groq = providerPreset("groq");

  it("offers Codex for a documented provider only after /responses works", () => {
    expect(codexVerdict({ preset: openrouter, responses: "works", experimental: false })).toEqual({ use: "yes" });
    const blocked: Array<[ResponsesCheck, string]> = [["missing", "route-missing"], ["key-refused", "key-refused"], ["unchecked", "not-checked"]];
    for (const [responses, reason] of blocked) {
      expect(codexVerdict({ preset: openrouter, responses, experimental: true })).toEqual({ use: "no", reason });
    }
  });

  it("keeps undocumented providers behind the experimental switch, and still needs the check", () => {
    expect(codexVerdict({ preset: groq, responses: "works", experimental: false })).toEqual({ use: "no", reason: "experimental-off" });
    expect(codexVerdict({ preset: groq, responses: "works", experimental: true })).toEqual({ use: "experimental" });
    expect(codexVerdict({ preset: groq, responses: "missing", experimental: true })).toEqual({ use: "no", reason: "route-missing" });
    // A custom provider has no preset: the same experimental rule applies.
    expect(codexVerdict({ preset: undefined, responses: "works", experimental: true })).toEqual({ use: "experimental" });
    expect(codexVerdict({ preset: undefined, responses: "works", experimental: false })).toEqual({ use: "no", reason: "experimental-off" });
  });

  it("never offers Codex where the provider rules it out, even with the switch on", () => {
    expect(codexVerdict({ preset: providerPreset("deepseek"), responses: "works", experimental: true }))
      .toEqual({ use: "no", reason: "provider-no-responses-api" });
    for (const id of ["cline-pass", "cline-credits"]) {
      expect(codexVerdict({ preset: providerPreset(id), responses: "works", experimental: true }))
        .toEqual({ use: "no", reason: "provider-unsupported" });
    }
  });

  it("refuses Fireworks Fire Pass keys and MiniMax models", () => {
    expect(codexVerdict({ preset: fireworks, responses: "works", experimental: false, key: "fpk_abc123" }))
      .toEqual({ use: "no", reason: "key-type" });
    expect(codexVerdict({ preset: fireworks, responses: "works", experimental: false, key: "fw_abc123" })).toEqual({ use: "yes" });
    expect(codexModels(fireworks, ["accounts/fireworks/models/minimax-m2p5", "accounts/fireworks/models/MiniMax-M3", "accounts/fireworks/models/glm-5"]))
      .toEqual(["accounts/fireworks/models/glm-5"]);
    // The deny rules belong to Fireworks alone.
    expect(codexModels(openrouter, ["minimax/minimax-m2"])).toEqual(["minimax/minimax-m2"]);
    expect(codexVerdict({ preset: openrouter, responses: "works", experimental: false, key: "fpk_abc" })).toEqual({ use: "yes" });
  });
});
