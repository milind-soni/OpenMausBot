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
      return { state: { ...actual.initialState, config, instances: fx.instances as never }, dispatch: fx.dispatch };
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

function paste(input: HTMLInputElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  flushSync(() => input.dispatchEvent(event));
}

beforeEach(() => {
  setLocale("en");
  fx.api.mockReset();
  fx.dispatch.mockReset();
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
  it("updates untouched Qwen fields and the credential destination after a remote settings change", () => {
    const live = { configured: false, provider: "qwen", qwenRegion: "cn-beijing", qwenWorkspace: "old-space", qwenModel: "qwen-audio-3.1-realtime-flash", qwenVoice: "old_custom", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    page();
    const form = row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!;
    flushSync(() => setConfig({ ...fx.config, live: { ...live, qwenRegion: "ap-southeast-1", qwenWorkspace: "current-space", qwenModel: "qwen-audio-3.1-realtime-plus", qwenVoice: "longanqian_v3.1" } }));
    expect(row("liveKey")!.querySelector("[data-qwen-live-settings]")).toBe(form);
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen API region"]')!.value).toBe("ap-southeast-1");
    expect(form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!.value).toBe("current-space");
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen model"]')!.value).toBe("qwen-audio-3.1-realtime-plus");
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen voice"]')!.value).toBe("longanqian_v3.1");
    expect(form.querySelector('[aria-label="Custom voice ID"]')).toBeNull();
    expect(row("liveKey")!.querySelector("[data-key-destination]")!.textContent).toContain("International (Singapore)");
    expect(row("liveKey")!.querySelector("[data-key-destination]")!.textContent).toContain("current-space");
    expect(fx.api).not.toHaveBeenCalled();
  });
  it("preserves edited Qwen fields while showing the saved credential destination", () => {
    const live = { configured: false, provider: "qwen", qwenRegion: "cn-beijing", qwenWorkspace: "saved-space", qwenModel: "qwen-audio-3.1-realtime-flash", qwenVoice: "saved_custom", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    page();
    const form = row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!;
    type(form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!, "draft-space");
    type(form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!, "longanqian_v3.1");
    flushSync(() => setConfig({ ...fx.config, live: { ...live, qwenRegion: "ap-southeast-1", qwenWorkspace: "current-space", qwenModel: "qwen-audio-3.1-realtime-plus", qwenVoice: "remote_custom" } }));
    expect(form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!.value).toBe("draft-space");
    expect(form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!.value).toBe("longanqian_v3.1");
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen API region"]')!.value).toBe("ap-southeast-1");
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen model"]')!.value).toBe("qwen-audio-3.1-realtime-plus");
    const destination = row("liveKey")!.querySelector("[data-key-destination]")!;
    expect(destination.textContent).toContain("International (Singapore)");
    expect(destination.textContent).toContain("current-space");
    expect(destination.textContent).not.toContain("draft-space");
    expect(fx.api).not.toHaveBeenCalled();
  });
  it("keeps every Qwen draft field when another client broadcasts saved settings", () => {
    const live = { configured: false, provider: "qwen", qwenRegion: "cn-beijing", qwenWorkspace: "saved", qwenModel: "qwen-audio-3.1-realtime-flash", qwenVoice: "longanqian_v3.1", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    page();
    const form = row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!;
    const choose = (label: string, value: string) => {
      const select = form.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      flushSync(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    choose("Qwen API region", "ap-southeast-1");
    choose("Qwen model", "qwen-audio-3.1-realtime-plus");
    choose("Qwen voice", "custom");
    type(form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!, "draft-workspace");
    type(form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!, "draft_voice");
    type(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-key-for-old-workspace");
    flushSync(() => setConfig({ ...fx.config, live: { ...live, qwenRegion: "ap-southeast-1", qwenWorkspace: "remote", qwenModel: "qwen-audio-3.1-realtime-plus", qwenVoice: "yuxiaoyun_v3.1" } }));
    expect(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!.value).toBe("");
    flushSync(() => setConfig({ ...fx.config, live: { ...live, qwenWorkspace: "another-remote" } }));
    expect(row("liveKey")!.querySelector("[data-qwen-live-settings]")).toBe(form);
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen API region"]')!.value).toBe("ap-southeast-1");
    expect(form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!.value).toBe("draft-workspace");
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen model"]')!.value).toBe("qwen-audio-3.1-realtime-plus");
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Qwen voice"]')!.value).toBe("custom");
    expect(form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!.value).toBe("draft_voice");
    expect(fx.api).not.toHaveBeenCalled();
  });
  it("loads saved provider settings and clears credential drafts when switching providers", () => {
    const live = { configured: false, provider: "qwen", qwenWorkspace: "saved-qwen", azureEndpoint: "https://old.openai.azure.com", azureDeployment: "old-deployment", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    page();
    type(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-qwen-key");
    flushSync(() => setConfig({ ...fx.config, live: { ...live, provider: "azure", azureEndpoint: "https://current.openai.azure.com", azureDeployment: "current-deployment" } }));
    const endpoint = row("liveKey")!.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(endpoint.value).toBe("https://current.openai.azure.com");
    expect(row("liveKey")!.querySelector<HTMLInputElement>('input[placeholder="gpt-live-1"]')!.value).toBe("current-deployment");
    expect(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!.value).toBe("");
    type(endpoint, "https://draft.openai.azure.com");
    type(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-azure-key");
    flushSync(() => setConfig({ ...fx.config, live }));
    expect(row("liveKey")!.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!.value).toBe("saved-qwen");
    expect(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!.value).toBe("");
    flushSync(() => setConfig({ ...fx.config, live: { ...live, provider: "azure" } }));
    expect(row("liveKey")!.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(live.azureEndpoint);
    expect(fx.api).not.toHaveBeenCalled();
  });
  it("resets Qwen drafts from a successful local save even when the saved settings did not change", async () => {
    const live = { configured: false, provider: "qwen", qwenRegion: "cn-beijing", qwenWorkspace: "saved", qwenModel: "qwen-audio-3.1-realtime-flash", qwenVoice: "longanqian_v3.1", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockResolvedValue({ live });
    page();
    const form = row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!;
    const workspace = form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!;
    const voice = form.querySelector<HTMLSelectElement>('[aria-label="Qwen voice"]')!;
    flushSync(() => { voice.value = "custom"; voice.dispatchEvent(new Event("change", { bubbles: true })); });
    type(workspace, "  saved  ");
    type(form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!, "  longanqian_v3.1  ");
    flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledOnce());
    expect(JSON.parse(fx.api.mock.calls[0][1].body)).toMatchObject({ qwenWorkspace: "saved", qwenVoice: "longanqian_v3.1" });
    await vi.waitFor(() => expect(workspace.value).toBe("saved"));
    expect(voice.value).toBe("longanqian_v3.1");
    expect(form.querySelector('[aria-label="Custom voice ID"]')).toBeNull();
    flushSync(() => setConfig({ ...fx.config, live: { ...live, qwenWorkspace: "remote-after-save", qwenVoice: "remote_custom" } }));
    expect(workspace.value).toBe("remote-after-save");
    expect(form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!.value).toBe("remote_custom");
  });
  it("preserves Qwen drafts when a local save fails", async () => {
    const live = { configured: false, provider: "qwen", qwenVoice: "saved_custom", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockRejectedValue(new Error("Fixture settings failure"));
    page();
    const form = row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!;
    const workspace = form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!;
    const voice = form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!;
    type(workspace, "draft-workspace");
    type(voice, "draft_custom");
    flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(row("liveKey")!.textContent).toContain("Fixture settings failure"));
    expect(workspace.value).toBe("draft-workspace");
    expect(voice.value).toBe("draft_custom");
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(fx.dispatch).not.toHaveBeenCalled();
  });
  it("blocks blank custom Qwen voices and matches the workspace length limit", async () => {
    setConfig({ ...fx.config, live: { configured: false, provider: "qwen", qwenVoice: "saved_custom", voice: "marin", readTypedReplies: true, idleMinutes: 5 } });
    page();
    const form = row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!;
    expect(form.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!.maxLength).toBe(63);
    const voice = form.querySelector<HTMLInputElement>('[aria-label="Custom voice ID"]')!;
    for (const value of ["", "   ", " \t "]) {
      type(voice, value);
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await Promise.resolve();
      expect(fx.api).not.toHaveBeenCalled();
    }
    type(voice, "valid_custom");
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
  it("saves an official Qwen voice, shows its Chinese traits, and keeps it after reopening or changing 3.1 models", async () => {
    setLocale("zh");
    const live = { configured: true, provider: "qwen", qwenKeyConfigured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockImplementation(async (_path: string, init: RequestInit) => ({ live: { ...live, ...JSON.parse(String(init.body)) } }));
    page();
    const getVoice = () => row("liveKey")!.querySelector<HTMLSelectElement>('select[aria-label="千问音色"]')!;
    expect(getVoice()).not.toBeNull();
    expect(getVoice().value).toBe("longanqian_v3.1");
    expect(getVoice().querySelector('[value="yuxiaoyun_v3.1"]')!.textContent).toContain("于小云");
    expect(getVoice().querySelector('[value="yuxiaoyun_v3.1"]')!.textContent).toContain("元气、亲切、自然");
    flushSync(() => { getVoice().value = "yuxiaoyun_v3.1"; getVoice().dispatchEvent(new Event("change", { bubbles: true })); });
    flushSync(() => row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledOnce());
    expect(JSON.parse(fx.api.mock.calls[0][1].body).qwenVoice).toBe("yuxiaoyun_v3.1");
    await vi.waitFor(() => expect(getVoice().value).toBe("yuxiaoyun_v3.1"));
    render(); page();
    expect(getVoice().value).toBe("yuxiaoyun_v3.1");
    const model = row("liveKey")!.querySelector<HTMLSelectElement>('select[aria-label="千问模型"]')!;
    flushSync(() => { model.value = "qwen-audio-3.1-realtime-plus"; model.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(getVoice().value).toBe("yuxiaoyun_v3.1");
    expect(row("liveKey")!.querySelector('input[aria-label="自定义音色 ID"]')).toBeNull();
    expect(row("liveKey")!.textContent).toContain("下一次通话");
  });
  it("preserves unknown/custom Qwen IDs and lets the user edit them without a silent default", async () => {
    const live = { configured: true, provider: "qwen", qwenVoice: "qwen-audio-3.1-realtime-flash-myvoice-fixture", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockImplementation(async (_path: string, init: RequestInit) => ({ live: { ...live, ...JSON.parse(String(init.body)) } }));
    page();
    const select = row("liveKey")!.querySelector<HTMLSelectElement>('select[aria-label="Qwen voice"]')!;
    expect(select).not.toBeNull();
    expect(select.value).toBe("custom");
    const input = row("liveKey")!.querySelector<HTMLInputElement>('input[aria-label="Custom voice ID"]')!;
    expect(input.value).toBe(live.qwenVoice);
    expect(input.maxLength).toBe(80);
    const model = row("liveKey")!.querySelector<HTMLSelectElement>('select[aria-label="Qwen model"]')!;
    flushSync(() => { model.value = "qwen-audio-3.1-realtime-plus"; model.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(input.value).toBe(live.qwenVoice);
    expect(row("liveKey")!.textContent).toContain("target model");
    type(input, "fixture-custom-voice");
    flushSync(() => row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledOnce());
    expect(JSON.parse(fx.api.mock.calls[0][1].body).qwenVoice).toBe("fixture-custom-voice");
    await vi.waitFor(() => expect(row("liveKey")!.querySelector<HTMLInputElement>('input[aria-label="Custom voice ID"]')!.value).toBe("fixture-custom-voice"));
    render(); page();
    expect(row("liveKey")!.querySelector<HTMLInputElement>('input[aria-label="Custom voice ID"]')!.value).toBe("fixture-custom-voice");
  });
  it("saves and clears Qwen through the server even when an older desktop bridge exists", async () => {
    const live = { configured: false, provider: "qwen", qwenKeyConfigured: false, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockImplementation(async (_path: string, init: RequestInit) => {
      const key = JSON.parse(String(init.body)).live.qwen.key;
      return { ...fx.config, live: { ...live, configured: !!key, qwenKeyConfigured: !!key } };
    });
    const setCredential = vi.fn(async () => { throw new Error("Older desktop does not know Qwen"); });
    const original = window.ogb;
    window.ogb = { setCredential } as never;
    try {
      page();
      paste(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-qwen-desktop-key");
      await vi.waitFor(() => expect(row("liveKey")!.querySelector("[data-key-masked]")).not.toBeNull());
      expect(fx.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ live: { qwen: { key: "fixture-qwen-desktop-key" } }, qwenKeyTarget: { region: "cn-beijing", workspace: "" } }) });
      flushSync(() => row("liveKey")!.querySelector<HTMLButtonElement>("[data-key-remove]")!.click());
      await vi.waitFor(() => expect(fx.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ live: { qwen: { key: "" } }, qwenKeyTarget: { region: "cn-beijing", workspace: "" } }) }));
      expect(setCredential).not.toHaveBeenCalled();
    } finally { window.ogb = original; }
  });

  it("shows the Qwen key editor and limited availability in Chinese", () => {
    setLocale("zh");
    setConfig({ ...fx.config, live: { provider: "qwen", qwenKeyConfigured: true, configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 } });
    page();
    expect(row("liveKey")!.textContent).toContain("千问实时通话 API 密钥");
    expect(row("liveKey")!.textContent).toContain("受限可用");
    expect(row("liveKey")!.textContent).toContain("审批请点击聊天卡片");
    expect(row("liveKey")!.textContent).toContain("按用量计费");
    expect(row("liveKey")!.querySelector("[data-key-masked]")).not.toBeNull();
    expect(row("liveKey")!.textContent).not.toContain("$0.05");
  });
  it("saves Qwen region, optional workspace, whitelisted model and a separate voice", async () => {
    const live = { configured: false, provider: "qwen", qwenKeyConfigured: false, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockImplementation(async (_path: string, init: RequestInit) => ({ live: { ...live, ...JSON.parse(String(init.body)) } }));
    page();
    const form = row("liveKey")!.querySelector<HTMLFormElement>("[data-qwen-live-settings]");
    expect(form).not.toBeNull();
    const region = form!.querySelector<HTMLSelectElement>('[aria-label="Qwen API region"]')!;
    expect([...region.options].map((option) => option.value)).toEqual(["cn-beijing", "ap-southeast-1"]);
    expect(region.value).toBe("cn-beijing");
    const model = form!.querySelector<HTMLSelectElement>('[aria-label="Qwen model"]')!;
    expect([...model.options].map((option) => option.value)).toEqual(["qwen-audio-3.1-realtime-flash", "qwen-audio-3.1-realtime-plus"]);
    const workspace = form!.querySelector<HTMLInputElement>('[aria-label="Qwen business space"]')!;
    const voiceChoice = form!.querySelector<HTMLSelectElement>('select[aria-label="Qwen voice"]')!;
    expect(workspace.value).toBe("");
    expect(voiceChoice.value).toBe("longanqian_v3.1");
    flushSync(() => { region.value = "ap-southeast-1"; region.dispatchEvent(new Event("change", { bubbles: true })); });
    flushSync(() => { model.value = "qwen-audio-3.1-realtime-plus"; model.dispatchEvent(new Event("change", { bubbles: true })); });
    flushSync(() => { voiceChoice.value = "custom"; voiceChoice.dispatchEvent(new Event("change", { bubbles: true })); });
    const voice = form!.querySelector<HTMLInputElement>('input[aria-label="Custom voice ID"]')!;
    type(workspace, "workspace-fixture"); type(voice, "fixture_voice_v3.1");
    flushSync(() => form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledOnce());
    expect(JSON.parse(fx.api.mock.calls[0][1].body)).toEqual({ provider: "qwen", qwenRegion: "ap-southeast-1", qwenWorkspace: "workspace-fixture", qwenModel: "qwen-audio-3.1-realtime-plus", qwenVoice: "fixture_voice_v3.1" });
    expect(row("liveKey")!.textContent).toContain("Limited availability");
    expect(row("liveKey")!.textContent).toContain("headphones");
    expect(row("liveKey")!.textContent).toContain("Billed by usage");
    expect(row("liveKey")!.textContent).not.toContain("$0.05");
  });
  it("saves, replaces and clears the Qwen key with the existing masked key editor", async () => {
    const live = { configured: false, provider: "qwen", qwenKeyConfigured: false, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockImplementation(async (_path: string, init: RequestInit) => {
      const key = JSON.parse(String(init.body)).live.qwen.key;
      return { ...fx.config, live: { ...live, configured: !!key, qwenKeyConfigured: !!key } };
    });
    page();
    paste(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-qwen-key-first");
    await vi.waitFor(() => expect(row("liveKey")!.querySelector("[data-key-masked]")).not.toBeNull());
    expect(JSON.parse(fx.api.mock.calls[0][1].body)).toEqual({ live: { qwen: { key: "fixture-qwen-key-first" } }, qwenKeyTarget: { region: "cn-beijing", workspace: "" } });
    expect(row("liveKey")!.textContent).toContain("Saved");
    expect(JSON.stringify(fx.config)).not.toContain("fixture-qwen-key");
    expect(host.innerHTML).not.toContain("fixture-qwen-key");
    flushSync(() => row("liveKey")!.querySelector<HTMLButtonElement>("[data-key-replace]")!.click());
    const replacement = row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!;
    type(replacement, "fixture-qwen-key-second");
    flushSync(() => row("liveKey")!.querySelector<HTMLButtonElement>("[data-key-save]")!.click());
    await vi.waitFor(() => expect(row("liveKey")!.querySelector("[data-key-masked]")).not.toBeNull());
    expect(JSON.parse(fx.api.mock.calls[1][1].body)).toEqual({ live: { qwen: { key: "fixture-qwen-key-second" } }, qwenKeyTarget: { region: "cn-beijing", workspace: "" } });
    flushSync(() => row("liveKey")!.querySelector<HTMLButtonElement>("[data-key-remove]")!.click());
    await vi.waitFor(() => expect(row("liveKey")!.querySelector("[data-key-masked]")).toBeNull());
    expect(JSON.parse(fx.api.mock.calls[2][1].body)).toEqual({ live: { qwen: { key: "" } }, qwenKeyTarget: { region: "cn-beijing", workspace: "" } });
    expect(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!.value).toBe("");
  });

  it("captures the displayed destination before a key save waits and uses the new destination after a remote change", async () => {
    const live = { configured: false, provider: "qwen", qwenRegion: "cn-beijing", qwenWorkspace: "old-space", qwenKeyConfigured: false, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    let refuse!: (error: Error) => void;
    fx.api.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    page();
    paste(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-key-old-destination");
    expect(JSON.parse(fx.api.mock.calls[0][1].body)).toEqual({ live: { qwen: { key: "fixture-key-old-destination" } }, qwenKeyTarget: { region: "cn-beijing", workspace: "old-space" } });
    const moved = { ...live, qwenRegion: "ap-southeast-1", qwenWorkspace: "new-space" };
    flushSync(() => setConfig({ ...fx.config, live: moved }));
    refuse(new Error("The Qwen key destination changed. Reload Call settings before saving or removing the key."));
    await Promise.resolve();
    expect(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!.value).toBe("");
    expect(row("liveKey")!.querySelector("[data-key-destination]")!.textContent).toContain("new-space");
    fx.api.mockResolvedValueOnce({ ...fx.config, live: { ...moved, configured: true, qwenKeyConfigured: true } });
    paste(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-key-new-destination");
    await vi.waitFor(() => expect(row("liveKey")!.querySelector("[data-key-masked]")).not.toBeNull());
    expect(JSON.parse(fx.api.mock.calls[1][1].body)).toEqual({ live: { qwen: { key: "fixture-key-new-destination" } }, qwenKeyTarget: { region: "ap-southeast-1", workspace: "new-space" } });
  });

  it("discards a draft key on provider switch rather than offering it to the new provider", async () => {
    const live = { configured: false, provider: "openai", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockImplementation(async () => ({ live: { ...live, provider: "qwen", qwenKeyConfigured: false } }));
    page();
    type(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!, "fixture-native-draft");
    const select = row("liveKey")!.querySelector<HTMLSelectElement>("select")!;
    flushSync(() => { select.value = "qwen"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(row("liveKey")!.textContent).toContain("Qwen API key"));
    expect(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!.value).toBe("");
    expect(fx.api).toHaveBeenCalledOnce();
  });
  it("selects Qwen on the existing Live key row and offers its independent key field", async () => {
    const live = { configured: false, provider: "openai", voice: "marin", readTypedReplies: true, idleMinutes: 5 };
    setConfig({ ...fx.config, live });
    fx.api.mockImplementation(async () => ({ live: { ...live, provider: "qwen", qwenKeyConfigured: false } }));
    page();
    const select = row("liveKey")!.querySelector<HTMLSelectElement>("select")!;
    expect([...select.options].map((option) => option.value)).toContain("qwen");
    flushSync(() => { select.value = "qwen"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(row("liveKey")!.textContent).toContain("Qwen API key for Live calls"));
    expect(fx.api).toHaveBeenCalledWith("/api/live/settings", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ provider: "qwen" }) }));
    expect(row("liveKey")!.querySelector<HTMLInputElement>("[data-key-input]")!.type).toBe("password");
    expect(host.querySelectorAll('[data-key-row="liveKey"]')).toHaveLength(1);
    expect(row("liveCalls")).toBeNull();
    expect(row("liveKey")!.textContent).toContain("Required");
    expect(row("liveKey")!.textContent).not.toContain("instead of your OpenAI key");
  });
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

  it("offers the Live calls service, OpenAI or Azure OpenAI, on the separate live key row", () => {
    setConfig({ ...fx.config, live: { configured: false, provider: "azure", voice: "", readTypedReplies: true, idleMinutes: 5 } });
    page();
    const select = row("liveKey")!.querySelector<HTMLSelectElement>("select")!;
    expect([...select.options].map((option) => option.value)).toEqual(["openai", "azure", "qwen"]);
    expect(select.value).toBe("azure");
    expect(row("liveKey")!.querySelector('input[type="url"]')).not.toBeNull();
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

  it("lands the live-call notice's button on the OpenAI row in Voice and calls, focused and lit", async () => {
    render(() => createElement(LiveKeyNeeded, { key: "notice" }), () => createElement(KeysPage, { key: "page" }));
    expect(expanded("voice")).toBe("false");
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Open API keys")!;
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
