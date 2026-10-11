import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/state/store";
import * as store from "@/state/store";
import { AnthropicEveryClaudeBot, ApiKeyRow, looksLikeKey, OpenAiCompatUrl, OpenCodeProviderKeys } from "./ApiKeys";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const render = (element: React.ReactElement) => {
  vi.stubGlobal("window", {});
  return renderToStaticMarkup(createElement(StoreProvider, null, element));
};

describe("provider key rows", () => {
  it("describes a stored key as configured without claiming an authenticated connection", () => {
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: {
        ...store.initialState.config, openaiCompat: { configured: true, url: "https://openrouter.ai/api/v1" },
      } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    const html = render(createElement(ApiKeyRow, { section: "openaiCompat", testProvider: "openaiCompat" }));
    expect(html).toContain("Configured");
    expect(html).not.toContain("Connected");
    expect(html).not.toContain("authenticated");
    expect(html).toContain(">Test<");
    expect(html).toContain('value=""');
  });

  it("renders the provider rows write-only, with the provider's own console linked", () => {
    const anthropic = render(createElement(ApiKeyRow, { section: "anthropic", testProvider: "anthropic" }));
    expect(anthropic).toContain("Anthropic API key");
    expect(anthropic).toContain('type="password"');
    expect(anthropic).toContain("sk-ant-…");
    // The console link and the description live in the help popover.
    expect(anthropic).toContain('aria-label="About Anthropic API key"');
    expect(anthropic).not.toContain("Connected");
    // Nothing to test until a key is typed or saved.
    expect(anthropic).not.toContain(">Test<");

    const compat = render(createElement(ApiKeyRow, { section: "openaiCompat", testProvider: "openaiCompat" }));
    expect(compat).toContain("OpenAI-compatible API key");
    expect(compat).toContain("Paste the server&#x27;s API key");
    expect(render(createElement(ApiKeyRow, { section: "openai", testProvider: "openai" }))).toContain("OpenAI API key");
    expect(render(createElement(ApiKeyRow, { section: "openrouter", testProvider: "openrouter" }))).toContain("sk-or-v1-…");

    expect(render(createElement(ApiKeyRow, { section: "xai", testProvider: "xai" }))).toContain("xAI API key");
    const groq = render(createElement(ApiKeyRow, { section: "groq", testProvider: "groq" }));
    expect(groq).toContain("Groq API key");
    expect(groq).toContain('type="password"');
    expect(groq).toContain('value=""');
    expect(groq).not.toContain("Connected");
    expect(groq).not.toContain(">Test<");
  });

  it("saves on paste instead of a Save button, and keeps key effects in view", () => {
    const anthropic = render(createElement(ApiKeyRow, { section: "anthropic", testProvider: "anthropic" }));
    expect(anthropic).not.toContain(">Save<");
    const openai = render(createElement(ApiKeyRow, { section: "openai", testProvider: "openai" }));
    expect(openai).toContain("Codex doesn&#x27;t use this key");
  });

  it("shows Cloud Pro's included computers as included, not as a saved key the person could clear", () => {
    const withBox = (box: store.ConfigStatus["box"]) => vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: { ...store.initialState.config, box } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    withBox({ configured: true, included: true });
    const included = render(createElement(ApiKeyRow, { section: "box" }));
    expect(included).toContain("Included with your Cloud plan");
    expect(included).not.toContain("Configured");
    // an own key can still be added, and there is nothing to remove
    expect(included).toContain('placeholder="Paste your Boat API key"');
    expect(included).not.toContain("Remove the saved key");

    withBox({ configured: true });
    const own = render(createElement(ApiKeyRow, { section: "box" }));
    expect(own).toContain("Configured");
    expect(own).not.toContain("Included with your Cloud plan");
  });

  it("warns about per-token billing only while the Anthropic key runs every Claude bot", () => {
    const withAnthropic = (everyClaudeBot: boolean) => vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: { ...store.initialState.config, anthropic: { configured: true, everyClaudeBot } } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    withAnthropic(false);
    const off = render(createElement(AnthropicEveryClaudeBot));
    expect(off).toContain("Use this key for every Claude bot");
    expect(off).toContain("Signed-in Claude bots stay on their plan");
    expect(off).not.toContain("instead of a Claude login");
    withAnthropic(true);
    expect(render(createElement(AnthropicEveryClaudeBot))).toContain("instead of a Claude login");
  });

  it("refuses pasted text that is not a key", () => {
    expect(looksLikeKey("sk-proj-abc123_DEF")).toBe(true);
    expect(looksLikeKey("The mascots are ready")).toBe(false);
    expect(looksLikeKey("sk-abc\n")).toBe(false);
  });

  it("lists the keys saved for OpenCode's other providers by name, with a way to add and remove one", () => {
    const withKeys = (providerKeys: string[] | undefined) => vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: { ...store.initialState.config, opencodeGo: { configured: false, providerKeys } } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    withKeys(["GROQ_API_KEY", "VENICE_API_KEY"]);
    const saved = render(createElement(OpenCodeProviderKeys));
    expect(saved).toContain("Keys for other OpenCode providers");
    expect(saved).toMatch(/<details[^>]*open=""/);
    for (const name of ["GROQ_API_KEY", "VENICE_API_KEY"]) {
      expect(saved).toContain(`data-opencode-provider-key="${name}"`);
      expect(saved).toContain(`aria-label="Remove ${name}"`);
    }
    // A new one: a name and a write-only key.
    expect(saved).toContain('placeholder="VENICE_API_KEY"');
    expect(saved).toContain('aria-label="Key name"');
    expect(saved).toMatch(/<input type="password"[^>]*aria-label="Key"/);

    // From a server that predates the list, or with nothing saved yet: closed and empty.
    withKeys(undefined);
    const none = render(createElement(OpenCodeProviderKeys));
    expect(none).not.toMatch(/<details[^>]*open=""/);
    expect(none).not.toContain("data-opencode-provider-key=");
    expect(none).toContain("such as VENICE_API_KEY for Venice");
  });

  it("offers the base URL as a setting next to the key", () => {
    const html = render(createElement(OpenAiCompatUrl));
    expect(html).toContain("OpenAI-compatible base URL");
    expect(html).toContain('placeholder="https://api.groq.com/openai/v1"');
    expect(html).toContain("localhost:11434/v1");
  });
});
