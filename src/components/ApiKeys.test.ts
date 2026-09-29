import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/state/store";
import * as store from "@/state/store";
import { ApiKeyRow, DecisionModelRouting, OpenAiCompatUrl } from "./ApiKeys";

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

    const openai = render(createElement(ApiKeyRow, { section: "openaiCompat", testProvider: "openaiCompat" }));
    expect(openai).toContain("OpenAI-compatible API key");
    expect(openai).toContain("sk-or-v1-…");

    expect(render(createElement(ApiKeyRow, { section: "xai", testProvider: "xai" }))).toContain("xAI API key");
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
    expect(included).toContain("Included with Cloud Pro");
    expect(included).not.toContain("Configured");
    // an own key can still be added, and there is nothing to remove
    expect(included).toContain('placeholder="Paste your Boat API key"');
    expect(included).not.toContain("Remove the saved key");

    withBox({ configured: true });
    const own = render(createElement(ApiKeyRow, { section: "box" }));
    expect(own).toContain("Configured");
    expect(own).not.toContain("Included with Cloud Pro");
  });

  it("offers the base URL as a setting next to the key", () => {
    const html = render(createElement(OpenAiCompatUrl));
    expect(html).toContain("OpenAI-compatible base URL");
    expect(html).toContain('placeholder="https://openrouter.ai/api/v1"');
    expect(html).toContain("api.openai.com/v1");
  });

  it("renders the decision-model key write-only like every other provider key", () => {
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: {
        ...store.initialState.config,
        decisionModel: { configured: true, keyPresent: true, url: "", model: "jev-latest", threshold: 0.9 },
      } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    const html = render(createElement(ApiKeyRow, { section: "decisionModel", testProvider: "decisionModel" }));
    expect(html).toContain("Decision model key");
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).not.toContain("Connected");
    expect(html).toContain(">Test<");
  });

  it("keeps a key saved before the route is complete clearable", () => {
    // keyPresent, not configured, drives this row: a key saved before a
    // lane and model are picked is still stored, so it must show as saved
    // and stay clearable instead of vanishing behind an unusable route
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: {
        ...store.initialState.config,
        decisionModel: { configured: false, keyPresent: true, provider: "typesafe", url: "", model: "", threshold: 0.9 },
      } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    const html = render(createElement(ApiKeyRow, { section: "decisionModel", testProvider: "decisionModel" }));
    expect(html).toContain("Configured");
    expect(html).toContain("paste to replace");
    expect(html).toContain("Remove the saved key");
    expect(html).toContain(">Clear<");
  });
});

describe("decision model routing", () => {
  const mockStore = (config?: store.ConfigStatus["decisionModel"]) => {
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: { ...store.initialState.config, ...(config ? { decisionModel: config } : {}) } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
  };

  it("offers every lane with routing fields and saves nothing until complete", () => {
    mockStore(undefined);
    const html = render(createElement(DecisionModelRouting));
    expect(html).toContain("TypeSafe");
    expect(html).toContain("Vercel AI Gateway");
    expect(html).toContain("OpenRouter");
    expect(html).toContain("Custom OpenAI-compatible endpoint");
    expect(html).toContain('<option value="" selected="">Not configured</option>');
    expect(html).toContain('aria-label="Lane"');
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Base URL"');
    expect(html).toContain('aria-label="Confidence threshold"');
    expect(html).toContain('value="0.9"');
    // An unconfigured connection starts clean and incomplete: Save stays off.
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("Use Test to run the calibration probe");
  });

  it("echoes a saved connection and points at the calibration probe", () => {
    mockStore({ configured: true, keyPresent: true, provider: "custom", url: "http://127.0.0.1:8787/v1", model: "local", threshold: 0.75 });
    const html = render(createElement(DecisionModelRouting));
    expect(html).toContain('value="local"');
    expect(html).toContain('value="http://127.0.0.1:8787/v1"');
    expect(html).toContain('value="0.75"');
    expect(html).toContain("Use Test to run the calibration probe");
  });

  it("offers Not configured only before a lane is saved, so a saved route has no dead-end selection", () => {
    mockStore({ configured: true, keyPresent: true, provider: "typesafe", url: "", model: "jev-latest", threshold: 0.9 });
    const html = render(createElement(DecisionModelRouting));
    expect(html).not.toContain('<option value="">');
    expect(html).toContain('value="typesafe"');
  });
});
