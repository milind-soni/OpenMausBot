// @vitest-environment happy-dom
import { createElement, Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fx = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  instances: [] as unknown[],
  listeners: new Set<() => void>(),
  api: vi.fn(),
  dispatch: vi.fn(),
  refreshModels: vi.fn(),
}));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { fx.listeners.add(listener); return () => { fx.listeners.delete(listener); }; };
  return {
    ...actual,
    api: (...args: unknown[]) => fx.api(...args),
    useStore: () => {
      const config = useSyncExternalStore(subscribe, () => fx.config);
      return { state: { ...actual.initialState, config, instances: fx.instances as never }, dispatch: fx.dispatch, refreshModels: fx.refreshModels };
    },
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/live-call-media", () => ({ dismissLiveNotice: vi.fn() }));

const { KeysPage } = await import("./KeysPage");
const { track } = await import("@/lib/analytics");
const { BOAT_OFFER, boatClaimMailto } = await import("@/lib/boat-offer");
const { BOAT_OFFER_NOTICE } = await import("@/lib/notices");
const { applyBrand, DEFAULT_BRAND } = await import("@/lib/brand");
const { LiveKeyNeeded } = await import("../LiveKeyNeeded");
const { openKeySettings } = await import("./key-focus");

let host: HTMLDivElement;
let root: Root;

function setConfig(config: Record<string, unknown>) {
  fx.config = config;
  for (const listener of Array.from(fx.listeners)) listener();
}

const render = (...children: Array<() => ReturnType<typeof createElement>>) =>
  flushSync(() => root.render(createElement(Fragment, null, ...children.map((child) => child()))));
const page = () => render(() => createElement(KeysPage, { key: "page" }));
const row = (id: string) => host.querySelector<HTMLElement>(`[data-key-row="${id}"]`);
const rowsShown = () => [...host.querySelectorAll<HTMLElement>("[data-key-row]")].filter((element) => !element.closest("[hidden]")).map((element) => element.dataset.keyRow);
const section = (id: string) => host.querySelector<HTMLElement>(`[data-keys-section="${id}"]`)!;
const expanded = (id: string) => section(id).querySelector("button[aria-expanded]")!.getAttribute("aria-expanded");

function type(input: HTMLInputElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function answered(reply: () => void) {
  reply();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

function paste(input: HTMLInputElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  flushSync(() => input.dispatchEvent(event));
}

beforeEach(() => {
  setLocale("en");
  fx.api.mockReset();
  fx.dispatch.mockReset();
  fx.refreshModels.mockReset();
  fx.refreshModels.mockResolvedValue(undefined);
  fx.dispatch.mockImplementation((action: { type: string; config?: Record<string, unknown> }) => {
    if (action.type === "configStatus") setConfig(action.config!);
  });
  fx.config = { composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" } };
  fx.instances = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("the keys page", () => {
  it("groups the keys into plain sections, AI providers open first", () => {
    page();
    expect([...host.querySelectorAll<HTMLElement>("[data-keys-section]")].map((element) => element.dataset.keysSection))
      .toEqual(["ai", "servers", "voice", "computers", "apps", "helpers"]);
    expect(section("ai").textContent).toContain("AI providers");
    expect(expanded("ai")).toBe("true");
    expect(expanded("voice")).toBe("false");
    expect(rowsShown()).toContain("openai");
    expect(rowsShown()).not.toContain("elevenlabs");
  });

  it("offers the Live calls service, OpenAI, Azure OpenAI, Fish Audio, Gemini, ElevenLabs or a custom endpoint, on the separate live key row", () => {
    setConfig({ ...fx.config, live: { configured: false, provider: "azure", voice: "", readTypedReplies: true, idleMinutes: 5 } });
    page();
    const select = row("liveKey")!.querySelector<HTMLSelectElement>("select")!;
    expect([...select.options].map((option) => option.value)).toEqual(["openai", "azure", "fish", "gemini", "elevenlabs", "custom"]);
    expect(select.value).toBe("azure");
    expect(row("liveKey")!.querySelector('input[type="url"]')).not.toBeNull();
  });

  it("with a custom endpoint chosen, the Live key row asks for that endpoint's key, with its address and model, and no OpenAI page", () => {
    const live = { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live: { ...live, provider: "custom", customEndpoint: "https://gateway.example.com/v1", customModel: "my-live" } });
    page();
    const custom = row("liveKey")!;
    expect(custom.textContent).toContain("Custom endpoint key for Live calls");
    expect(custom.textContent).toContain("Required");
    expect(custom.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe("https://gateway.example.com/v1");
    expect([...custom.querySelectorAll("input")].map((input) => input.value)).toContain("my-live");
    expect(custom.querySelector<HTMLAnchorElement>('a[href*="platform.openai.com"]')).toBeNull();
    expect(row("liveCalls")).toBeNull();
  });

  it("with Azure chosen, the Live key row asks for an Azure key: required, no OpenAI wording, and no row saying Live uses the OpenAI key", () => {
    const live = { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live: { ...live, provider: "azure", azureEndpoint: "https://my-res.openai.azure.com" } });
    page();
    const azure = row("liveKey")!;
    expect(azure.textContent).toContain("Azure OpenAI key for Live calls");
    expect(azure.textContent).toContain("Required");
    expect(azure.textContent).not.toContain("Optional");
    expect(azure.textContent).not.toContain("Separate key");
    expect(azure.textContent).not.toContain("instead of your OpenAI key");
    expect([...azure.querySelectorAll("input")].map((input) => input.placeholder)).not.toContain("sk-…");
    expect(azure.querySelector<HTMLAnchorElement>('a[href*="platform.openai.com"]')).toBeNull();
    expect(row("liveCalls")).toBeNull();

    setConfig({ ...fx.config, live });
    page();
    const openAi = row("liveKey")!;
    expect(openAi.textContent).toContain("Optional");
    expect([...openAi.querySelectorAll("input")].map((input) => input.placeholder)).toContain("sk-…");
    expect(row("liveCalls")).not.toBeNull();
  });

  it("with Fish Audio chosen, the Live key row is the required Fish Audio key, with no OpenAI wording and nothing else to fill in", () => {
    setConfig({ ...fx.config, live: { configured: false, provider: "fish", voice: "", readTypedReplies: true, idleMinutes: 5 } });
    page();
    const fish = row("liveKey")!;
    expect(fish.textContent).toContain("Fish Audio");
    expect(fish.textContent).toContain("Required");
    expect(fish.textContent).not.toContain("instead of your OpenAI key");
    expect([...fish.querySelectorAll("input")].map((input) => input.placeholder)).not.toContain("sk-…");
    expect(fish.querySelector<HTMLAnchorElement>('a[href*="platform.openai.com"]')).toBeNull();
    expect(fish.querySelector<HTMLAnchorElement>('a[href*="fish.audio"]')).not.toBeNull();
    expect([...fish.querySelectorAll<HTMLInputElement>("input")].every((input) => input.type === "password")).toBe(true);
    expect(row("liveCalls")).toBeNull();
  });

  it("drops a key typed on the Live key row when the Live calls service changes, so it is never saved for the other service", () => {
    const live = { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live: { ...live, provider: "fish" } });
    page();
    const field = () => row("liveKey")!.querySelector<HTMLInputElement>('input[type="password"]')!;
    type(field(), "typed-for-fish-audio");
    expect(field().value).toBe("typed-for-fish-audio");

    flushSync(() => setConfig({ ...fx.config, live: { ...live, provider: "elevenlabs" } }));
    expect(row("liveKey")!.textContent).toContain("ElevenLabs");
    expect(field().value).toBe("");
  });

  it("shows nothing of a key save that finishes after the Live calls service changed", async () => {
    const live = { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live: { ...live, provider: "fish" } });
    let answer: (value: unknown) => void = () => {};
    fx.api.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    page();
    const field = () => row("liveKey")!.querySelector<HTMLInputElement>('input[type="password"]')!;
    paste(field(), "typed-for-fish-audio");
    expect(fx.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ body: JSON.stringify({ tts: { fishKey: "typed-for-fish-audio" } }) }));

    flushSync(() => setConfig({ ...fx.config, live: { ...live, provider: "elevenlabs" } }));
    await answered(() => answer({ ...fx.config }));
    expect(row("liveKey")!.textContent).toContain("ElevenLabs");
    expect(row("liveKey")!.textContent).not.toContain("didn't stay saved");
    expect(fx.api).toHaveBeenCalledTimes(1);
  });

  it("opens a section that holds a saved key, and counts what is connected", () => {
    setConfig({ ...fx.config, box: { configured: true, last4: "c3d4" } });
    page();
    expect(expanded("computers")).toBe("true");
    expect(section("computers").textContent).toContain("1 connected");
  });

  it("filters rows live by name, purpose and section, and says so when nothing matches", () => {
    page();
    const search = host.querySelector<HTMLInputElement>("[data-keys-search]")!;
    type(search, "fish");
    expect(rowsShown()).toEqual(["fishAudio"]);
    type(search, "Computers and browser");
    expect(rowsShown()).toEqual(["box", "vps", "onePassword"]);
    type(search, "research");
    expect(rowsShown()).toEqual(["treg"]);
    type(search, "zzz");
    expect(rowsShown()).toEqual([]);
    expect(host.querySelector("[data-keys-empty]")!.textContent).toBe("No keys match “zzz”.");
  });

  it("saves a Fish key as the Fish Audio key, holding the Live provider while it saves and the key while a provider change does", async () => {
    const live = { configured: false, provider: "fish", voice: "", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    let answer: (value: unknown) => void = () => {};
    fx.api.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    render(() => createElement(LiveKeyNeeded, { key: "notice" }));
    const provider = () => host.querySelector<HTMLSelectElement>("select")!;
    const saveKey = () => host.querySelector<HTMLInputElement>('input[type="password"]')!.closest("form")!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "fish-key");
    flushSync(() => saveKey().click());
    expect(fx.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT", body: JSON.stringify({ tts: { fishKey: "fish-key" } }) }));
    expect(provider().disabled).toBe(true);
    expect(fx.api).toHaveBeenCalledTimes(1);
    await answered(() => answer({ ...fx.config, live: { ...live, keySource: "fishAudio" } }));
    expect(provider().disabled).toBe(false);

    setConfig({ ...fx.config, live });
    flushSync(() => {
      provider().value = "openai";
      provider().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fx.api).toHaveBeenLastCalledWith("/api/live/settings", expect.objectContaining({ method: "PATCH" }));
    type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "fish-key");
    expect(saveKey().disabled).toBe(true);
    await answered(() => answer({ live }));
    expect(saveKey().disabled).toBe(false);
  });

  it("lands the live-call notice's button on the OpenAI row in Voice and calls, focused and lit", async () => {
    render(() => createElement(LiveKeyNeeded, { key: "notice" }), () => createElement(KeysPage, { key: "page" }));
    expect(expanded("voice")).toBe("false");
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Open AI › Other services")!;
    flushSync(() => button.click());
    expect(fx.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "connections" });
    const live = () => row("liveCalls")!.querySelector<HTMLInputElement>("[data-key-input]")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(live()));
    expect(expanded("voice")).toBe("true");
    expect(row("liveCalls")!.hasAttribute("data-key-highlight")).toBe(true);
    expect(live().getAttribute("aria-label")).toBe("OpenAI API key");
    expect(row("liveCalls")!.textContent).toContain("Live calls use the same key as OpenAI's models");
  });

  it("clears a search that would hide the row a link asks for", async () => {
    page();
    type(host.querySelector<HTMLInputElement>("[data-keys-search]")!, "fish");
    flushSync(() => { openKeySettings("box"); });
    await vi.waitFor(() => expect(document.activeElement).toBe(row("box")!.querySelector("[data-key-input]")));
    expect(host.querySelector<HTMLInputElement>("[data-keys-search]")!.value).toBe("");
  });

  it("warns, and saves nothing, when a pasted key looks like another provider's", () => {
    page();
    const input = row("openai")!.querySelector<HTMLInputElement>("[data-key-input]")!;
    paste(input, "  sk-ant-api03-abcdefghijklmnop\n");
    expect(row("openai")!.textContent).toContain("That looks like the Anthropic API key, not this one.");
    expect(input.value).toBe("sk-ant-api03-abcdefghijklmnop");
    expect(fx.api).not.toHaveBeenCalled();
  });

  it("saves a pasted key, reads it back masked with a check, and keeps it in view when a later check rejects it", async () => {
    fx.api.mockImplementation(async (path: string) => path === "/api/config"
      ? { ...fx.config, openai: { configured: true, last4: "a1b2" } }
      : { ok: false, reason: "rejected" });
    page();
    paste(row("openai")!.querySelector<HTMLInputElement>("[data-key-input]")!, "sk-proj-abcdefghijklmnopa1b2");
    await vi.waitFor(() => expect(row("openai")!.textContent).toContain("Didn't work: The provider rejected this key."));
    expect(fx.api.mock.calls.map(([path]) => path)).toEqual(["/api/config", "/api/keys/test"]);
    expect(JSON.parse(fx.api.mock.calls[0]![1].body)).toEqual({ openai: { key: "sk-proj-abcdefghijklmnopa1b2" } });
    const masked = row("openai")!.querySelector("[data-key-masked]")!;
    expect(masked.textContent).toContain("••••••••a1b2");
    expect(row("openai")!.querySelector("[data-key-input]")).toBeNull();
    expect(row("openai")!.querySelector("[data-key-replace]")).not.toBeNull();
  });

  it("confirms a key the server checked on save as Connected", async () => {
    fx.api.mockImplementation(async () => ({ ...fx.config, box: { configured: true, last4: "c3d4" } }));
    setConfig({ ...fx.config });
    page();
    flushSync(() => section("computers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    const input = row("box")!.querySelector<HTMLInputElement>("[data-key-input]")!;
    type(input, "boat_dummy_fixture_key_c3d4");
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await vi.waitFor(() => expect(row("box")!.querySelector("[data-key-masked]")?.textContent).toContain("••••••••c3d4"));
    expect(row("box")!.textContent).toContain("Connected");
    expect(fx.api).toHaveBeenCalledOnce();
  });
});

describe("the OpenAI-compatible server row", () => {
  it("offers the reply wait for the built-in server once its base URL is set, such as a local Ollama", () => {
    const waitFor = () => host.querySelector('select[aria-label="How long to wait for Other (OpenAI-compatible) to reply"]');
    fx.instances = [{ instanceId: "openaiCompat", driverKind: "openai-compat", displayName: "Other (OpenAI-compatible)", snapshot: { state: "available" } }];
    page();
    expect(waitFor()).toBeNull();
    flushSync(() => setConfig({ ...fx.config, openaiCompat: { url: "http://localhost:11434/v1" } }));
    expect(row("openaiCompat")).not.toBeNull();
    expect(waitFor()).not.toBeNull();
    flushSync(() => setConfig({ ...fx.config, openaiCompat: { url: "" } }));
    expect(waitFor()).toBeNull();
  });
});

describe("the OpenAI-compatible key check", () => {
  it("checks the saved key again at the base URL typed after it, such as Venice", async () => {
    fx.config = { ...fx.config, openaiCompat: { configured: true, last4: "1234" } };
    const tested: Array<string | undefined> = [];
    fx.api.mockImplementation(async (path: string, init: { body: string }) => {
      if (path === "/api/config") return { ...fx.config, openaiCompat: { ...(fx.config.openaiCompat as object), ...JSON.parse(init.body).openaiCompat } };
      if (path !== "/api/keys/test") return {};
      const url = (fx.config.openaiCompat as { url?: string }).url;
      tested.push(url);
      return url === "https://api.venice.ai/api/v1" ? { ok: true, check: "models", models: ["venice-uncensored"] } : { ok: false, reason: "rejected" };
    });
    page();
    flushSync(() => section("servers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    const url = row("openaiCompat")!.querySelector<HTMLInputElement>('input[aria-label="OpenAI-compatible base URL"]')!;
    type(url, "https://api.venice.ai/api/v1");
    flushSync(() => url.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await vi.waitFor(() => expect(row("openaiCompat")!.textContent).toContain("venice-uncensored"));
    expect(tested).toEqual(["https://api.venice.ai/api/v1"]);
    expect(row("openaiCompat")!.textContent).not.toContain("Didn't work");
  });

  it("checks again when the base URL changes while a check is still running", async () => {
    fx.config = { ...fx.config, openaiCompat: { configured: true, last4: "1234" } };
    const tested: Array<string | undefined> = [];
    let answerFirst: (result: unknown) => void = () => {};
    fx.api.mockImplementation((path: string) => {
      if (path !== "/api/keys/test") return Promise.resolve({});
      const url = (fx.config.openaiCompat as { url?: string }).url;
      tested.push(url);
      if (tested.length === 1) return new Promise((resolve) => { answerFirst = resolve; });
      return Promise.resolve({ ok: true, check: "models", models: ["venice-uncensored"] });
    });
    page();
    flushSync(() => section("servers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    flushSync(() => setConfig({ ...fx.config, openaiCompat: { configured: true, last4: "1234", url: "https://api.example.test/v1" } }));
    await vi.waitFor(() => expect(tested).toEqual(["https://api.example.test/v1"]));
    flushSync(() => setConfig({ ...fx.config, openaiCompat: { configured: true, last4: "1234", url: "https://api.venice.ai/api/v1" } }));
    answerFirst({ ok: false, reason: "rejected" });
    await vi.waitFor(() => expect(row("openaiCompat")!.textContent).toContain("venice-uncensored"));
    expect(tested).toEqual(["https://api.example.test/v1", "https://api.venice.ai/api/v1"]);
    expect(row("openaiCompat")!.textContent).not.toContain("Didn't work");
  });

  it("checks again when the base URL changes while a check that then fails is still running", async () => {
    fx.config = { ...fx.config, openaiCompat: { configured: true, last4: "1234" } };
    const tested: Array<string | undefined> = [];
    let failFirst: (cause: Error) => void = () => {};
    fx.api.mockImplementation((path: string) => {
      if (path !== "/api/keys/test") return Promise.resolve({});
      const url = (fx.config.openaiCompat as { url?: string }).url;
      tested.push(url);
      if (tested.length === 1) return new Promise((_resolve, reject) => { failFirst = reject; });
      return Promise.resolve({ ok: true, check: "models", models: ["venice-uncensored"] });
    });
    page();
    flushSync(() => section("servers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    flushSync(() => setConfig({ ...fx.config, openaiCompat: { configured: true, last4: "1234", url: "https://api.example.test/v1" } }));
    await vi.waitFor(() => expect(tested).toEqual(["https://api.example.test/v1"]));
    flushSync(() => setConfig({ ...fx.config, openaiCompat: { configured: true, last4: "1234", url: "https://api.venice.ai/api/v1" } }));
    failFirst(new Error("network down"));
    await vi.waitFor(() => expect(row("openaiCompat")!.textContent).toContain("venice-uncensored"));
    expect(tested).toEqual(["https://api.example.test/v1", "https://api.venice.ai/api/v1"]);
    expect(row("openaiCompat")!.textContent).not.toContain("network down");
  });

  it("does not check the key when the page opens or nothing about the address changed", async () => {
    fx.config = { ...fx.config, openaiCompat: { configured: true, last4: "1234", url: "https://api.venice.ai/api/v1" } };
    fx.api.mockResolvedValue({});
    page();
    flushSync(() => section("servers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    flushSync(() => setConfig({ ...fx.config, openaiCompat: { configured: true, last4: "1234", url: "https://api.venice.ai/api/v1" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fx.api.mock.calls.map(([path]) => path)).not.toContain("/api/keys/test");
  });

  it("does not check when no key is saved yet", async () => {
    fx.api.mockImplementation(async (path: string, init: { body: string }) => (path === "/api/config" ? { ...fx.config, openaiCompat: JSON.parse(init.body).openaiCompat } : {}));
    page();
    flushSync(() => section("servers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    const url = row("openaiCompat")!.querySelector<HTMLInputElement>('input[aria-label="OpenAI-compatible base URL"]')!;
    type(url, "https://api.venice.ai/api/v1");
    flushSync(() => url.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await vi.waitFor(() => expect(fx.api.mock.calls.map(([path]) => path)).toContain("/api/config"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fx.api.mock.calls.map(([path]) => path)).not.toContain("/api/keys/test");
  });

  it("is found by searching for Venice", () => {
    page();
    const search = host.querySelector<HTMLInputElement>("[data-keys-search]")!;
    type(search, "venice");
    expect(rowsShown()).toContain("openaiCompat");
  });
});

describe("the Ollama row", () => {
  const openServers = () => flushSync(() => section("servers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  const button = (text: string) => [...row("ollama")!.querySelectorAll("button")].find((candidate) => candidate.textContent === text)!;
  const found = (state: string) => vi.waitFor(() => expect(row("ollama")!.querySelector(`[data-ollama-state="${state}"]`)).not.toBeNull());
  const answer = (state: string, url = "http://127.0.0.1:11434", models: unknown[] = []) => {
    fx.api.mockImplementation(async (path: string) => path.startsWith("/api/instances/ollama") ? { status: { state, url, models } } : { instances: [] });
  };

  it("looks only once its section is open, and adds what it found with no key or address to type", async () => {
    answer("ready", undefined, [{ name: "llama3.2:latest" }]);
    page();
    expect(fx.api).not.toHaveBeenCalled();
    openServers();
    await found("ready");
    expect(row("ollama")!.textContent).toContain("Pulled models: 1.");
    expect(fx.api.mock.calls.map(([path]) => path)).toEqual(["/api/instances/ollama"]);
    flushSync(() => button("Add Ollama").click());
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledTimes(2));
    expect(fx.api.mock.calls[1]![0]).toBe("/api/instances/openai-compat");
    expect(JSON.parse(fx.api.mock.calls[1]![1].body)).toEqual({ displayName: "Ollama", url: "http://127.0.0.1:11434/v1", key: "ollama", catalog: "ollama" });
  });

  it("asks at the address someone enters", async () => {
    answer("no-models");
    page();
    openServers();
    await found("no-models");
    expect(row("ollama")!.textContent).toContain("ollama pull llama3.2");
    answer("ready", "http://gpu-box.local:11434", [{ name: "qwen3:4b" }]);
    type(row("ollama")!.querySelector<HTMLInputElement>("input")!, "http://gpu-box.local:11434");
    flushSync(() => button("Check again").click());
    await found("ready");
    expect(fx.api.mock.calls.at(-1)![0]).toBe(`/api/instances/ollama?url=${encodeURIComponent("http://gpu-box.local:11434")}`);
  });

  it("offers nothing to add while Ollama isn't running, only how to start or get it", async () => {
    answer("not-running");
    page();
    openServers();
    await found("not-running");
    expect(button("Add Ollama").disabled).toBe(true);
    expect(row("ollama")!.querySelector<HTMLAnchorElement>('a[href="https://ollama.com/download"]')).not.toBeNull();
    expect(row("ollama")!.textContent).toContain("ollama serve");
  });

  it("says when this Ollama is already added, through the built-in server or an added one", async () => {
    answer("ready", undefined, [{ name: "llama3.2:latest" }]);
    fx.config = { ...fx.config, openaiCompat: { url: "http://127.0.0.1:11434/v1/" } };
    page();
    openServers();
    await found("ready");
    expect(row("ollama")!.textContent).toContain("already added");
    expect(button("Add Ollama").disabled).toBe(true);
  });

  it("reloads the added Ollama's model list when a check finds a model it lacks, as after ollama pull", async () => {
    const served = (instanceId: string, url: string) => ({
      instanceId, driverKind: "openai-compat", displayName: "Ollama", url, snapshot: { state: "available" },
      models: { default: "qwen3.5:9b", options: [{ id: "qwen3.5:9b", label: "qwen3.5:9b" }, { id: "bonsai-2:9b", label: "bonsai-2:9b" }] },
    });
    fx.instances = [served("openai-compat-here", "http://127.0.0.1:11434/v1"), served("openai-compat-elsewhere", "http://gpu-box.local:11434/v1")];
    answer("ready", undefined, [{ name: "qwen3.5:9b" }, { name: "bonsai-2:9b" }]);
    page();
    openServers();
    await found("ready");
    expect(fx.refreshModels).not.toHaveBeenCalled();
    const [here, elsewhere] = fx.instances as Array<ReturnType<typeof served>>;
    fx.instances = [{ ...here!, models: { ...here!.models, options: here!.models.options.slice(0, 1) } }, elsewhere!];
    setConfig({ ...fx.config });
    await Promise.resolve();
    expect(fx.refreshModels, "a list that changes after a check that needed no reload is not reloaded from that old check").not.toHaveBeenCalled();
    answer("ready", undefined, [{ name: "qwen3.5:9b" }, { name: "bonsai-2:9b" }, { name: "nemotron-3.5-bolt:e4b" }]);
    flushSync(() => button("Check again").click());
    await vi.waitFor(() => expect(row("ollama")!.textContent).toContain("Pulled models: 3."));
    await vi.waitFor(() => expect(fx.refreshModels).toHaveBeenCalledWith("openai-compat-here"));
    expect(fx.refreshModels).toHaveBeenCalledOnce();
  });
});

describe("Boat's credit offer on the Boat card", () => {
  const offer = () => row("box")!.querySelector<HTMLElement>("[data-boat-offer]");
  const buttons = () => [...offer()!.querySelectorAll<HTMLButtonElement>("button")];
  const openComputers = () => flushSync(() => section("computers").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  afterEach(() => {
    BOAT_OFFER.until = null;
    applyBrand({ brand: DEFAULT_BRAND, source: "default", file: "" });
    delete (window as unknown as { ogb?: unknown }).ogb;
    vi.unstubAllGlobals();
  });

  it("is always on the Boat card while the offer runs: with no key, a saved key, one a Cloud plan includes, and after its popup closed", () => {
    page(); openComputers();
    for (const box of [{ configured: false }, { configured: true, last4: "c3d4" }, { configured: false, included: true }]) {
      setConfig({ ...fx.config, box });
      expect(offer(), JSON.stringify(box)).not.toBeNull();
      expect(offer()!.closest("[hidden]")).toBeNull();
      const words = offer()!.textContent!;
      for (const text of ["$50 of Boat credit for you", "Boat runs the cloud computers behind MausBot.", "You claim it yourself: it isn't automatic."]) {
        expect(words).toContain(text);
      }
      expect(buttons().map((button) => button.textContent)).toEqual(["Get Boat", "I bought it: claim my $50"]);
    }
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === BOAT_OFFER_NOTICE ? "1" : null), setItem: () => {}, removeItem: () => {} });
    page();
    expect(offer(), "closing the popup never takes it from Settings").not.toBeNull();
    type(host.querySelector<HTMLInputElement>("[data-keys-search]")!, "boat");
    expect(rowsShown()).toContain("box"); expect(offer()!.closest("[hidden]")).toBeNull();
  });

  it("Get Boat opens boat.dev and the claim drafts the email to Boat; both stay for a later visit and save nothing", async () => {
    const openExternal = vi.fn(async () => true);
    (window as unknown as { ogb?: unknown }).ogb = { openExternal };
    page(); openComputers();
    flushSync(() => buttons()[0]!.click());
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://boat.dev"));
    flushSync(() => buttons()[1]!.click());
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(boatClaimMailto()));
    await vi.waitFor(() => expect(track).toHaveBeenCalledWith("boat_offer", { action: "claim", place: "settings" }));
    expect(track).toHaveBeenCalledWith("boat_offer", { action: "get_boat", place: "settings" });
    expect(offer()).not.toBeNull();
    expect(fx.api).not.toHaveBeenCalled();
  });

  it("goes from its end date on, and on a branded build, while the Boat card stays", () => {
    BOAT_OFFER.until = Date.now() - 1;
    page();
    expect(row("box")).not.toBeNull(); expect(offer()).toBeNull();
    BOAT_OFFER.until = null;
    applyBrand({ brand: { name: "Acme Bots" }, source: "file", file: "brand.json" });
    page();
    expect(row("box")).not.toBeNull(); expect(offer()).toBeNull();
  });
});

describe("Your own servers (SSH)", () => {
  it("labels the add row's fields the way the editor above it does", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    render(() => createElement(VpsConnection, { key: "vps" }));
    const labels = [...host.querySelectorAll("[data-vps-add] label")].map((label) => label.textContent);
    expect(labels).toEqual(["Name", "Name in your SSH settings", "Memory for each bot (GB)", "Processor cores for each bot"]);
    for (const label of host.querySelectorAll<HTMLLabelElement>("[data-vps-add] label")) expect(document.getElementById(label.htmlFor)?.tagName).toBe("INPUT");
  });

  const status = (vps: Record<string, unknown>) => ({ ...fx.config, vps: { configured: true, memoryGb: 4, cpus: 2, servers: [], ...vps } });
  const rowFor = (alias: string) => host.querySelector<HTMLElement>(`[data-vps-server="${alias}"]`)!;
  const aliases = () => [...host.querySelectorAll<HTMLElement>("[data-vps-server]")].map((element) => element.dataset.vpsServer);
  const links = () => [...host.querySelectorAll<HTMLElement>("[data-vps-server-link]")].map((element) => element.dataset.vpsServerLink);
  // An editor's fields carry their own visible labels inside a group named for the server; the add row's carry aria-labels.
  const labelled = (scope: ParentNode | null, text: string) => {
    const label = [...(scope?.querySelectorAll("label") ?? [])].find((one) => one.textContent === text);
    return (label ? document.getElementById(label.htmlFor) : null) as HTMLInputElement;
  };
  const group = (name: string) => host.querySelector<HTMLElement>(`[data-vps-server][aria-label="${name}"]`);
  const field = (label: string): HTMLInputElement => {
    const limit = /^(.+) (memory \(GB\)|CPU cores)$/.exec(label);
    if (limit && group(limit[1]!)) return labelled(group(limit[1]!), limit[2] === "CPU cores" ? "Processor cores for each bot" : "Memory for each bot (GB)");
    const name = /^(.+) server name$/.exec(label);
    if (name) return labelled(rowFor(name[1]!), "Name");
    const adding = host.querySelector("[data-vps-add]");
    const ADD: Record<string, string> = { "Server name": "Name", "Server SSH config alias": "Name in your SSH settings", "Memory (GB)": "Memory for each bot (GB)", "CPU cores": "Processor cores for each bot" };
    if (ADD[label]) return labelled(adding, ADD[label]!);
    const aria = label === "Self-hosted VPS SSH config alias" ? "Name in your SSH settings" : label;
    return host.querySelector<HTMLInputElement>(`input[aria-label="${aria}"]`) ?? labelled(host.querySelector("[data-vps-server]"), aria);
  };
  const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text)!;
  const lastBody = () => JSON.parse((fx.api.mock.lastCall![1] as RequestInit).body as string);
  const echo = (base: Record<string, unknown>) => async (_path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return status({ ...base, ...(body.vps ? { ...body.vps, configured: Boolean(body.vps.sshAlias) } : {}), ...(body.vpsServers ? { servers: body.vpsServers } : {}) });
  };

  it("says in plain words that a Linux computer with Docker you sign in to with SSH works, one on Tailscale too", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    render(() => createElement(VpsConnection, { key: "vps" }));
    const text = host.querySelector("[data-vps-connection]")!.textContent!;
    expect(text).toContain("A Linux computer with Docker that you sign in to with SSH.");
    expect(text).toContain("use its Tailscale name as the HostName in your SSH settings");
    expect(text).not.toMatch(/\bVPS\b|\balias\b|config/);
  });

  it("saves the first alias as the default server, then shows it with its limits", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    fx.api.mockImplementation(echo({}));
    render(() => createElement(VpsConnection, { key: "vps" }));
    expect(aliases()).toEqual([]);
    type(field("Self-hosted VPS SSH config alias"), "production-vps");
    await answered(() => button(host, "Save").click());
    expect(lastBody()).toEqual({ vps: { sshAlias: "production-vps" } });
    expect(aliases()).toEqual(["production-vps"]);
    expect(field("production-vps memory (GB)").value).toBe("4");
    expect(field("production-vps CPU cores").value).toBe("2");
  });

  it("adds named servers as one list, leaving the default alias alone, and lists each as a link to its row on Devices", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    const { SettingsShellContext } = await import("../settings/settings-shell");
    const go = vi.fn();
    setConfig(status({ sshAlias: "production-vps", servers: [{ name: "Office", sshAlias: "office-vps" }] }));
    fx.api.mockImplementation(echo({ sshAlias: "production-vps" }));
    render(() => createElement(SettingsShellContext.Provider, { value: { go } as never }, createElement(VpsConnection, { key: "vps" })));
    expect(aliases(), "only the default is edited here").toEqual(["production-vps"]);
    expect(links()).toEqual(["office-vps"]);
    const office = host.querySelector<HTMLElement>("[data-vps-server-link=office-vps]")!;
    expect(office.textContent).toBe("OfficeName in your SSH settings: office-vpsDevices");
    expect(office.getAttribute("aria-label")).toBe("Edit Office in Devices");
    type(field("Server name"), " Home lab ");
    type(field("Server SSH config alias"), "home-lab");
    await answered(() => button(host, "Add").click());
    expect(lastBody()).toEqual({ vpsServers: [{ name: "Office", sshAlias: "office-vps" }, { name: "Home lab", sshAlias: "home-lab" }] });
    expect(links()).toEqual(["office-vps", "home-lab"]);
    expect(field("Server name").value).toBe("");
    expect(field("Self-hosted VPS SSH config alias").value).toBe("production-vps");
    office.click();
    expect(go).toHaveBeenCalledWith("devices", "ssh:office-vps");
  });

  it("removes a named server from its editor as one list", async () => {
    const { VpsServerEditor } = await import("./VpsServerEditor");
    setConfig(status({ sshAlias: "production-vps", servers: [{ name: "Office", sshAlias: "office-vps" }, { name: "Home lab", sshAlias: "home-lab" }] }));
    fx.api.mockImplementation(echo({ sshAlias: "production-vps" }));
    render(() => createElement(VpsServerEditor, { key: "office", alias: "office-vps" }));
    await answered(() => host.querySelector<HTMLButtonElement>('button[aria-label="Remove Office"]')!.click());
    expect(lastBody()).toEqual({ vpsServers: [{ name: "Home lab", sshAlias: "home-lab" }] });
    expect(aliases()).toEqual([]);
  });

  it("renames a named server and saves its own limits, an empty one showing and using the default's", async () => {
    const { VpsServerEditor } = await import("./VpsServerEditor");
    setConfig(status({ sshAlias: "production-vps", memoryGb: 6, cpus: 3, servers: [{ name: "Office", sshAlias: "office-vps", cpus: 4 }] }));
    fx.api.mockImplementation(echo({ sshAlias: "production-vps", memoryGb: 6, cpus: 3 }));
    render(() => createElement(VpsServerEditor, { key: "office", alias: "office-vps" }));
    const office = rowFor("office-vps");
    expect(office.textContent).toContain("office-vps");
    expect(field("Office memory (GB)").value).toBe("");
    expect(field("Office memory (GB)").placeholder).toBe("6 (default)");
    expect(field("Office CPU cores").value).toBe("4");
    expect(button(office, "Save").disabled).toBe(true);
    type(field("office-vps server name"), "HQ");
    type(field("Office memory (GB)"), "8");
    type(field("Office CPU cores"), "");
    await answered(() => button(office, "Save").click());
    expect(lastBody()).toEqual({ vpsServers: [{ name: "HQ", sshAlias: "office-vps", memoryGb: 8 }] });
    expect(field("HQ memory (GB)").value).toBe("8");
    expect(button(rowFor("office-vps"), "Save").disabled).toBe(true);
  });

  it("saves the default server's limits with its alias, an empty field meaning 4 GB and 2 cores", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    setConfig(status({ sshAlias: "production-vps", memoryGb: 8, cpus: 4 }));
    fx.api.mockImplementation(echo({ sshAlias: "production-vps" }));
    render(() => createElement(VpsConnection, { key: "vps" }));
    type(field("production-vps memory (GB)"), "16");
    type(field("production-vps CPU cores"), "");
    await answered(() => button(rowFor("production-vps"), "Save").click());
    expect(lastBody()).toEqual({ vps: { sshAlias: "production-vps", memoryGb: 16, cpus: 2 } });
  });

  it("keeps Save off for a limit out of range or not a whole number", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    setConfig(status({ sshAlias: "production-vps" }));
    render(() => createElement(VpsConnection, { key: "vps" }));
    const save = () => button(rowFor("production-vps"), "Save");
    for (const bad of ["1", "129", "2.5"]) {
      type(field("production-vps memory (GB)"), bad);
      expect(save().disabled).toBe(true);
      expect(field("production-vps memory (GB)").getAttribute("aria-invalid")).toBe("true");
    }
    type(field("production-vps memory (GB)"), "12");
    expect(save().disabled).toBe(false);
    type(field("production-vps CPU cores"), "65");
    expect(save().disabled).toBe(true);
  });

  it("removes the default server, says what the server answered, and offers the alias field again", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    setConfig(status({ sshAlias: "production-vps", servers: [{ name: "Office", sshAlias: "office-vps" }] }));
    fx.api.mockImplementation(async () => ({ ...status({ configured: false, sshAlias: "", servers: [{ name: "Office", sshAlias: "office-vps" }] }), notice: "Removed. production-vps could not be reached" }));
    render(() => createElement(VpsConnection, { key: "vps" }));
    await answered(() => host.querySelector<HTMLButtonElement>('button[aria-label="Remove production-vps"]')!.click());
    expect(lastBody()).toEqual({ vps: { sshAlias: "" } });
    expect(aliases()).toEqual([]);
    expect(links()).toEqual(["office-vps"]);
    expect(host.querySelector("[data-vps-connection] [role=status]")!.textContent).toContain("could not be reached");
    expect(field("Self-hosted VPS SSH config alias").value).toBe("");
  });

  it("shows why a limit was refused on its own row and keeps what was typed", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    setConfig(status({ sshAlias: "production-vps" }));
    fx.api.mockRejectedValue(new Error("production-vps has 2 CPU cores in all. Choose 2 or fewer."));
    render(() => createElement(VpsConnection, { key: "vps" }));
    type(field("production-vps CPU cores"), "8");
    await answered(() => button(rowFor("production-vps"), "Save").click());
    expect(rowFor("production-vps").querySelector("[role=alert]")!.textContent).toContain("2 CPU cores in all");
    expect(field("production-vps CPU cores").value).toBe("8");
  });

  it("changes the default server's alias in place and says what the server answered", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    setConfig(status({ sshAlias: "production-vps" }));
    fx.api.mockImplementation(async () => ({ ...status({ sshAlias: "new-vps" }), notice: "production-vps keeps its desktops" }));
    render(() => createElement(VpsConnection, { key: "vps" }));
    type(field("Self-hosted VPS SSH config alias"), "new-vps");
    await answered(() => button(rowFor("production-vps"), "Save").click());
    expect(lastBody()).toEqual({ vps: { sshAlias: "new-vps", memoryGb: 4, cpus: 2 } });
    expect(aliases()).toEqual(["new-vps"]);
    expect(rowFor("new-vps").querySelector("[role=status]")!.textContent).toContain("keeps its desktops");
  });

  it("adds a server with its own limits after the host refused the ones it would inherit", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    setConfig(status({ sshAlias: "production-vps", memoryGb: 16 }));
    fx.api.mockRejectedValueOnce(new Error("spare has about 8 GB of memory. Choose 8 GB or less."));
    render(() => createElement(VpsConnection, { key: "vps" }));
    expect(field("Memory (GB)").placeholder).toBe("16 (default)");
    type(field("Server name"), "Spare");
    type(field("Server SSH config alias"), "spare");
    await answered(() => button(host, "Add").click());
    expect(lastBody()).toEqual({ vpsServers: [{ name: "Spare", sshAlias: "spare" }] });
    expect(host.querySelector("[data-vps-servers] [role=alert]")!.textContent).toContain("Choose 8 GB or less");
    fx.api.mockImplementation(echo({ sshAlias: "production-vps", memoryGb: 16 }));
    type(field("Memory (GB)"), "8");
    await answered(() => button(host, "Add").click());
    expect(lastBody()).toEqual({ vpsServers: [{ name: "Spare", sshAlias: "spare", memoryGb: 8 }] });
    expect(aliases()).toEqual(["production-vps"]);
    expect(links()).toEqual(["spare"]);
    expect(field("Memory (GB)").value).toBe("");
  });

  it("opens the same editor from a vps:<alias> server id, as the computers list carries it", async () => {
    const { VpsServerEditor } = await import("./VpsServerEditor");
    setConfig(status({ sshAlias: "production-vps", servers: [{ name: "Office", sshAlias: "office-vps", cpus: 4 }] }));
    fx.api.mockImplementation(echo({ sshAlias: "production-vps" }));
    render(() => createElement(VpsServerEditor, { key: "office", serverId: "vps:office-vps" }));
    expect(aliases()).toEqual(["office-vps"]);
    expect(field("Office CPU cores").value).toBe("4");
    type(field("Office CPU cores"), "3");
    await answered(() => button(rowFor("office-vps"), "Save").click());
    expect(lastBody()).toEqual({ vpsServers: [{ name: "Office", sshAlias: "office-vps", cpus: 3 }] });
    render(() => createElement(VpsServerEditor, { key: "gone", serverId: "vps:office-vps/openmausbot-vps-bot-abc" }));
    expect(aliases()).toEqual([]);
  });

  it("focuses the default server's alias when a link asks for the VPS row", async () => {
    setConfig(status({ sshAlias: "production-vps" }));
    page();
    flushSync(() => { openKeySettings("vps"); });
    await vi.waitFor(() => expect(document.activeElement).toBe(field("Self-hosted VPS SSH config alias")));
  });

  it("shows why a named server was refused and keeps what was typed", async () => {
    const { VpsConnection } = await import("./VpsServersPanel");
    fx.api.mockRejectedValue(new Error("vpsServers: each server needs its own SSH alias"));
    render(() => createElement(VpsConnection, { key: "vps" }));
    type(field("Server name"), "Lab");
    type(field("Server SSH config alias"), "lab");
    await answered(() => button(host, "Add").click());
    expect(host.querySelector("[data-vps-servers] [role=alert]")!.textContent).toContain("own SSH alias");
    expect(field("Server name").value).toBe("Lab");
  });
});

describe("Voice server address in Other services", () => {
  const voiceInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Chatterbox server address"]')!;
  const voiceAction = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("[data-voice-server-url] button")].find((button) => button.textContent === label)!;

  it("shows, validates, updates, and clears a stale voice server address even when another voice provider is active", async () => {
    setConfig({ ...fx.config, tts: { provider: "elevenlabs", configured: true, ready: true, voice: "v1", baseUrl: "http://127.0.0.1:4123", model: "" } });
    page();
    expect(expanded("voice")).toBe("true");
    expect(voiceInput().value).toBe("http://127.0.0.1:4123");

    type(voiceInput(), "not-a-url");
    flushSync(() => voiceAction("Save").click());
    expect(host.querySelector("[data-voice-server-url] [role=alert]")!.textContent).toContain("http:// or https://");
    expect(fx.api).not.toHaveBeenCalled();

    fx.api.mockResolvedValueOnce({ ...fx.config, tts: { provider: "elevenlabs", configured: true, ready: true, voice: "v1", baseUrl: "http://127.0.0.1:4124", model: "" } });
    type(voiceInput(), "http://127.0.0.1:4124");
    await answered(() => voiceAction("Save").click());
    expect(fx.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ tts: { baseUrl: "http://127.0.0.1:4124" } }) });

    fx.api.mockResolvedValueOnce({ ...fx.config, tts: { provider: "elevenlabs", configured: true, ready: true, voice: "v1", baseUrl: "", model: "" } });
    await answered(() => voiceAction("Remove").click());
    expect(fx.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ tts: { baseUrl: "" } }) });
    expect(voiceInput().value).toBe("");
  });
});
