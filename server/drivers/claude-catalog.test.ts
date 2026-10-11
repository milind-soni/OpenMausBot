import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeDriver, readClaudeModelCatalog, STATIC_CLAUDE_MODELS } from "./claude.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readClaudeModelCatalog", () => {
  it("returns the official models when settings are missing", () => {
    expect(readClaudeModelCatalog({ HOME: join(tmpdir(), "omb-claude-missing-home") })).toEqual(STATIC_CLAUDE_MODELS);
    expect(STATIC_CLAUDE_MODELS.options.slice(0, 2)).toEqual([
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-fable-5", label: "Claude Fable 5" },
    ]);
    const ids = STATIC_CLAUDE_MODELS.options.map((option) => option.id);
    expect(STATIC_CLAUDE_MODELS.options[ids.indexOf("claude-opus-5-5")]).toEqual({
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      contextWindow: 1_000_000,
    });
    expect(ids.indexOf("claude-opus-5-5")).toBe(ids.indexOf("claude-opus-5") - 1);
    expect(STATIC_CLAUDE_MODELS.options[ids.indexOf("claude-sonnet-5-5")]).toEqual({
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      contextWindow: 1_000_000,
    });
    expect(ids.indexOf("claude-sonnet-5-5")).toBe(ids.indexOf("claude-sonnet-5") - 1);
    expect(STATIC_CLAUDE_MODELS.default).toBe("claude-sonnet-5");
  });

  it("lists ANTHROPIC_MODEL from the instance environment when settings are missing", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-missing-home-"));
    scratchDirs.push(home);
    const catalog = readClaudeModelCatalog({ HOME: join(home, "missing"), ANTHROPIC_MODEL: "MiniMax-M3" });
    expect(catalog.options).toEqual([...STATIC_CLAUDE_MODELS.options, { id: "MiniMax-M3", label: "MiniMax-M3", custom: true }]);
  });

  it("tags extra settings models as custom and leaves official rows untagged", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-catalog-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        model: "claude-sonnet-5",
        availableModels: [{ id: "my-local-opus", name: "Local Opus" }],
        env: { ANTHROPIC_MODEL: "hosted-qwen" },
      }),
    );

    expect(readClaudeModelCatalog({ HOME: home })).toEqual({
      default: "claude-sonnet-5",
      options: [
        ...STATIC_CLAUDE_MODELS.options,
        { id: "my-local-opus", label: "Local Opus", custom: true },
        { id: "hosted-qwen", label: "hosted-qwen", custom: true },
      ],
    });
  });

  it("lists Claude Code's custom model option and non-Claude tier models as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-catalog-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        model: "opus[1m]",
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example",
          ANTHROPIC_CUSTOM_MODEL_OPTION: "qwen-27b",
          ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Qwen 27B",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-large[1m]",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen-27b",
          CLAUDE_CODE_SUBAGENT_MODEL: "subagent-model",
        },
      }),
    );

    expect(readClaudeModelCatalog({ HOME: home }).options.slice(STATIC_CLAUDE_MODELS.options.length)).toEqual([
      { id: "qwen-27b", label: "Qwen 27B", custom: true },
      { id: "glm-large[1m]", label: "glm-large[1m]", custom: true },
    ]);
  });

  it("lists a newer Anthropic model from extraModels with the official rows, not as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-catalog-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ extraModels: [
        { id: "claude-sonnet-future-test", label: "Future Claude Sonnet" },
        "claude-sonnet-future-test[1m]", "omlx::local-qwen",
      ] }),
    );

    expect(readClaudeModelCatalog({ HOME: home }).options.slice(STATIC_CLAUDE_MODELS.options.length)).toEqual([
      { id: "claude-sonnet-future-test", label: "Future Claude Sonnet" },
      { id: "claude-sonnet-future-test[1m]", label: "claude-sonnet-future-test[1m]" },
      { id: "omlx::local-qwen", label: "omlx::local-qwen", custom: true },
    ]);
  });

  it.each(["settings", "instance"])("keeps an official-looking model override custom for a compatible endpoint in %s", (source) => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-compatible-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const override = {
      ANTHROPIC_BASE_URL: "https://compatible.example.test/anthropic",
      ANTHROPIC_AUTH_TOKEN: "fake-compatible-key",
      ANTHROPIC_MODEL: "claude-compatible-test",
    };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      extraModels: [override.ANTHROPIC_MODEL],
      ...(source === "settings" ? { env: override } : {}),
    }));

    const catalog = readClaudeModelCatalog({ HOME: home, ...(source === "instance" ? override : {}) });
    expect(catalog.options.slice(STATIC_CLAUDE_MODELS.options.length)).toEqual([
      { id: override.ANTHROPIC_MODEL, label: override.ANTHROPIC_MODEL, custom: true },
    ]);
  });

  it("keeps official-looking availableModels and customModels custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-custom-catalog-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      availableModels: ["claude-available-test"], customModels: ["claude-custom-test"],
    }));
    expect(readClaudeModelCatalog({ HOME: home }).options.slice(STATIC_CLAUDE_MODELS.options.length)).toEqual([
      { id: "claude-available-test", label: "claude-available-test", custom: true },
      { id: "claude-custom-test", label: "claude-custom-test", custom: true },
    ]);
  });

  it("does not list settings.model as a Custom leftover", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-leftover-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "orcarouter/Qwen3.8-27B-Uncensored-GGUF" }),
    );

    expect(readClaudeModelCatalog({ HOME: home })).toEqual(STATIC_CLAUDE_MODELS);
  });
});

describe("ClaudeDriver catalog", () => {
  it("loads extras when the instance is created", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-instance-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ customModels: ["local-glm"] }));
    const instance = await ClaudeDriver.create({
      instanceId: "claude-catalog",
      displayName: "Claude",
      environment: { HOME: home },
      enabled: true,
      config: ClaudeDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((option) => option.id === "local-glm" && option.custom)).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});
