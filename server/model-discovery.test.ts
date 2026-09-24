import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { discoverAcpModels, discoverClaudeModels, discoverCodexModels, parseGrokModels, parseTabModels } from "./model-discovery.ts";

const testing = join(dirname(fileURLToPath(import.meta.url)), "testing");
const codex = join(testing, "fake-codex-app-server.ts");
const claude = join(testing, "fake-claude-cli.ts");
const acp = join(testing, "fake-acp-model-cli.ts");

afterEach(() => {
  delete process.env.FAKE_CODEX_MODELS;
  delete process.env.FAKE_CODEX_MODELS_PAGE_2;
  delete process.env.FAKE_CLAUDE_MODELS;
});

describe.skipIf(process.platform === "win32")("CLI model discovery", () => {
  it("uses Codex's advertised models and default, removing retired entries on refresh", async () => {
    chmodSync(codex, 0o755);
    process.env.FAKE_CODEX_MODELS = JSON.stringify([
      { model: "gpt-next", displayName: "GPT Next", isDefault: true },
      { model: "gpt-old", displayName: "GPT Old", hidden: true },
    ]);
    expect(await discoverCodexModels(codex)).toEqual({
      default: "gpt-next", options: [{ id: "gpt-next", label: "GPT Next" }],
    });
    process.env.FAKE_CODEX_MODELS = JSON.stringify([{ model: "gpt-later", displayName: "GPT Later", isDefault: true }]);
    expect((await discoverCodexModels(codex)).options.map((m) => m.id)).toEqual(["gpt-later"]);
  });

  it("follows Codex catalog pagination", async () => {
    chmodSync(codex, 0o755);
    process.env.FAKE_CODEX_MODELS = JSON.stringify([{ model: "gpt-first", displayName: "First" }]);
    process.env.FAKE_CODEX_MODELS_PAGE_2 = JSON.stringify([{ model: "gpt-second", displayName: "Second", isDefault: true }]);
    expect(await discoverCodexModels(codex)).toEqual({
      default: "gpt-second",
      options: [{ id: "gpt-first", label: "First" }, { id: "gpt-second", label: "Second" }],
    });
  });

  it("uses Claude's control initialization without sending a prompt", async () => {
    chmodSync(claude, 0o755);
    process.env.FAKE_CLAUDE_MODELS = JSON.stringify([
      { value: "default", resolvedModel: "claude-next", displayName: "Default" },
      { value: "claude-next", displayName: "Claude Next" },
    ]);
    expect(await discoverClaudeModels(claude)).toEqual({
      default: "default",
      options: [{ id: "default", label: "Default" }, { id: "claude-next", label: "Claude Next" }],
    });
  });

  it("reads an ACP session's advertised models", async () => {
    chmodSync(acp, 0o755);
    expect(await discoverAcpModels(acp, ["--experimental-acp"])).toEqual({
      default: "gemini-new",
      options: [{ id: "gemini-new", label: "Gemini New" }, { id: "gemini-fast", label: "Gemini Fast" }],
    });
  });
});

it("parses Antigravity's tab-separated catalog without treating progress text as a model", () => {
  expect(parseTabModels("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n"))
    .toEqual({ default: "gemini-3.8-flash-high", options: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }] });
});

it("parses Grok's authenticated model list and default", () => {
  expect(parseGrokModels("You are logged in.\n\nDefault model: grok-new\n\nAvailable models:\n * grok-new (default)\n - grok-old\n"))
    .toEqual({ default: "grok-new", options: [{ id: "grok-new", label: "grok-new" }, { id: "grok-old", label: "grok-old" }] });
});
