// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";

const fixture = vi.hoisted(() => ({ config: null as ConfigStatus | null, api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));
const { ImageGenerationSettings } = await import("./ImageGenerationSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLElement;

async function mount(config: NonNullable<ConfigStatus["imageGen"]>) {
  fixture.config = { imageGen: config } as ConfigStatus;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(createElement(ImageGenerationSettings)); });
  return container;
}

async function choose(label: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

const sentPatches = () => fixture.api.mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
  .map(([path, init]) => [path, JSON.parse(String((init as RequestInit).body))]);
const options = (label: string) => [...container.querySelectorAll<HTMLOptionElement>(`select[aria-label="${label}"] option`)]
  .map((option) => [option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : "", option.value]);
const LIVE = {
  source: "openrouter",
  models: [
    { id: "google/gemini-2.5-flash-image", name: "Google: Nano Banana", group: "recommended" },
    { id: "acme/painter-9", name: "Acme: Painter 9", group: "more" },
  ],
};

beforeEach(() => {
  fixture.api.mockReset().mockResolvedValue({});
  fixture.dispatch.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("Image generation settings", () => {
  it("says nothing is set up and asks for the base key on a fresh install", async () => {
    const view = await mount({ configured: false, primary: { provider: "openai", model: "gpt-image-2", configured: false }, fallback: null, ready: false });
    expect(view.textContent).toContain("Not set up");
    expect(view.textContent).toContain("Needs a key: add it below.");
    expect(view.querySelector('input[aria-label="OpenAI API key"]')).not.toBeNull();
    expect(view.querySelector('input[aria-label="Gemini API key"]')).toBeNull();
  });

  it("names the backup when only the backup can run, and shows a key field for each chosen provider", async () => {
    const view = await mount({
      configured: false, ready: true, xaiConfigured: true,
      primary: { provider: "gemini", model: "gemini-2.5-flash-image", configured: false },
      fallback: { provider: "xai", model: "grok-imagine-image-2.0", configured: true },
    });
    expect(view.textContent).toContain("Ready with the backup only · images are made with Grok (xAI)");
    expect(view.querySelector('input[aria-label="Gemini API key"]')).not.toBeNull();
    expect(view.querySelector('input[aria-label="Grok (xAI) API key"]')).not.toBeNull();
    expect(view.textContent).toContain("also used");
  });

  it("offers every provider but the base as the backup, and None", async () => {
    const view = await mount({ configured: true, ready: true, primary: { provider: "openai", model: "gpt-image-2", configured: true }, fallback: null });
    const options = [...view.querySelectorAll<HTMLOptionElement>('select[aria-label="Backup provider"] option')].map((option) => option.value);
    expect(options).toEqual(["", "xai", "gemini", "openrouter", "custom"]);
  });

  it("saves a chosen base, a cleared backup and the per-reply limit", async () => {
    await mount({ configured: true, ready: true, primary: { provider: "openai", model: "gpt-image-2", configured: true }, fallback: { provider: "xai", model: "grok-imagine-image-2.0", configured: true } });
    await choose("Base provider", "openrouter");
    await choose("Backup provider", "");
    await choose("Images per reply", "2");
    expect(sentPatches()).toEqual([
      ["/api/config", { imageGen: { primary: { provider: "openrouter" } } }],
      ["/api/config", { imageGen: { fallback: null } }],
      ["/api/config", { imageGen: { maxPerTurn: 2 } }],
    ]);
  });

  it("drops the backup when the base becomes the backup's provider, so no hidden backup is kept", async () => {
    await mount({ configured: true, ready: true, primary: { provider: "openai", model: "gpt-image-2", configured: true }, fallback: { provider: "xai", model: "grok-imagine-image-2.0", configured: true } });
    await choose("Base provider", "xai");
    expect(sentPatches()).toEqual([["/api/config", { imageGen: { primary: { provider: "xai" }, fallback: null } }]]);
  });

  it("lists OpenRouter's image models from its catalog and saves the one picked", async () => {
    fixture.api.mockImplementation(async (path: string) => (path === "/api/images/openrouter-models" ? LIVE : {}));
    await mount({ configured: true, ready: true, openrouterConfigured: true, primary: { provider: "openrouter", model: "google/gemini-2.5-flash-image", configured: true }, fallback: null });
    expect(options("Base provider model")).toEqual([
      ["Recommended", "google/gemini-2.5-flash-image"],
      ["More models", "acme/painter-9"],
      ["", "\u0000other"],
    ]);
    await choose("Base provider model", "acme/painter-9");
    expect(sentPatches()).toEqual([["/api/config", { imageGen: { primary: { provider: "openrouter", model: "acme/painter-9" } } }]]);
  });

  it("shows the built-in list and says so when OpenRouter's catalog cannot be loaded", async () => {
    fixture.api.mockImplementation(async (path: string) => { if (path === "/api/images/openrouter-models") throw new Error("offline"); return {}; });
    const view = await mount({ configured: true, ready: true, openrouterConfigured: true, primary: { provider: "openrouter", model: "google/gemini-2.5-flash-image", configured: true }, fallback: null });
    expect(view.textContent).toContain("built-in list");
    expect(options("Base provider model").map(([, id]) => id)).toContain("openai/gpt-image-2");
  });

  it("keeps a model typed by hand: Other opens a field for the ID", async () => {
    await mount({ configured: true, ready: true, primary: { provider: "openai", model: "gpt-image-2", configured: true }, fallback: null });
    expect(container.querySelector('input[aria-label="Base provider model ID"]')).toBeNull();
    await choose("Base provider model", "\u0000other");
    const input = await type("Base provider model ID", "gpt-image-3-preview");
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(sentPatches()).toEqual([["/api/config", { imageGen: { primary: { provider: "openai", model: "gpt-image-3-preview" } } }]]);
  });

  it("tests a saved key without saving anything and says what it found", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/images/test") return { ok: false, reason: "model_missing", model: "acme/nope-9" };
      return path === "/api/images/openrouter-models" ? LIVE : {};
    });
    const view = await mount({ configured: true, ready: true, openrouterConfigured: true, primary: { provider: "openrouter", model: "acme/nope-9", configured: true }, fallback: null });
    const button = [...view.querySelectorAll("button")].find((item) => item.textContent === "Test")!;
    await act(async () => { button.click(); });
    expect(fixture.api).toHaveBeenCalledWith("/api/images/test", { method: "POST", body: JSON.stringify({ provider: "openrouter" }) });
    expect(view.textContent).toContain("OpenRouter has no model acme/nope-9. Pick one from the list.");
    expect(sentPatches()).toEqual([]);
  });

  it("hides an OpenRouter Test verdict once the image models it checked change", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/images/test") return { ok: false, reason: "model_missing", model: "acme/nope-9" };
      return path === "/api/images/openrouter-models" ? LIVE : {};
    });
    const tested = { configured: true, ready: true, openrouterConfigured: true, primary: { provider: "openrouter" as const, model: "acme/nope-9", configured: true }, fallback: null };
    const view = await mount(tested);
    await act(async () => { [...view.querySelectorAll("button")].find((item) => item.textContent === "Test")!.click(); });
    expect(view.textContent).toContain("OpenRouter has no model acme/nope-9.");
    fixture.config = { imageGen: { ...tested, primary: { ...tested.primary, model: "acme/painter-9" } } } as ConfigStatus;
    await act(async () => { root!.render(createElement(ImageGenerationSettings)); });
    expect(view.textContent).not.toContain("OpenRouter has no model acme/nope-9.");
  });

  it("offers no Test before a key is saved", async () => {
    const view = await mount({ configured: false, ready: false, primary: { provider: "openai", model: "gpt-image-2", configured: false }, fallback: null });
    expect([...view.querySelectorAll("button")].some((item) => item.textContent === "Test")).toBe(false);
  });

  it("takes the OpenRouter key on this page and saves it as the shared OpenRouter key", async () => {
    await mount({ configured: false, ready: false, primary: { provider: "openrouter", model: "google/gemini-2.5-flash-image", configured: false }, fallback: null });
    const input = await type("OpenRouter API key", "or-new-key");
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(sentPatches()).toEqual([["/api/config", { openrouter: { key: "or-new-key" } }]]);
  });
});
