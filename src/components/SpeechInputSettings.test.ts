// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { STT_PRESETS, type SttStatus } from "../../shared/stt";
import { t } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  api: vi.fn(), dispatch: vi.fn(),
  config: { stt: { provider: "auto", baseUrl: "https://api.openai.com/v1", model: "whisper-1", configured: false, keyConfigured: false } } as { stt: SttStatus },
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
import { SpeechInputSettings } from "./SpeechInputSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  fixture.config = { stt: { provider: "auto", baseUrl: STT_PRESETS.openai.baseUrl, model: "", configured: false, keyConfigured: false } };
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.api.mockResolvedValue(fixture.config);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SpeechInputSettings)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function select(index: number, value: string) {
  const element = host.querySelectorAll("select")[index]!;
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function input(type: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function save() { await act(async () => host.querySelector<HTMLButtonElement>("[data-stt-save]")!.click()); }
async function enterModel(value: string) {
  const element = host.querySelector<HTMLInputElement>('input:not([type])')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("fills the Groq preset and saves its transcription model and a separate key", async () => {
  await select(0, "openai");
  await select(1, "groq");
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(STT_PRESETS.groq.baseUrl);
  await input("password", "groq-speech-secret");
  await enterModel("whisper-large-v3-turbo");
  await save();
  expect(JSON.parse(fixture.api.mock.calls[0]![1].body)).toEqual({ stt: { provider: "openai", ...STT_PRESETS.groq, model: "whisper-large-v3-turbo", key: "groq-speech-secret" } });
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
});

it("fills Google settings and discards the previous provider's draft key", async () => {
  await select(0, "openai");
  await input("password", "openai-only-key");
  await select(0, "gemini");
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(STT_PRESETS.google.baseUrl);
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(host.querySelectorAll("select")).toHaveLength(1);
  await input("password", "google-input-key");
  await enterModel("gemini-fixture-audio");
  await save();
  expect(JSON.parse(fixture.api.mock.calls[0]![1].body)).toEqual({ stt: { provider: "gemini", ...STT_PRESETS.google, model: "gemini-fixture-audio", key: "google-input-key" } });
  await select(0, "openai");
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(STT_PRESETS.openai.baseUrl);
  expect(host.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe("");
});

it("does not offer another provider's saved key at the same URL as a usable Google key", async () => {
  fixture.config = { stt: { provider: "openai", baseUrl: STT_PRESETS.google.baseUrl, model: "whisper-1", configured: true, keyConfigured: true } };
  await act(async () => root.render(createElement(SpeechInputSettings)));
  await select(0, "gemini");
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.placeholder).toBe("Google AI Studio API key");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
});

it("discards a draft credential when its destination changes and permits a keyless local server", async () => {
  await select(0, "openai");
  await input("password", "openai-secret");
  await select(1, "custom");
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  await input("url", "http://localhost:8000/v1");
  const model = host.querySelector<HTMLInputElement>('input:not([type])')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(model, "local-whisper");
    model.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await save();
  expect(JSON.parse(fixture.api.mock.calls[0]![1].body)).toEqual({ stt: { provider: "openai", baseUrl: "http://localhost:8000/v1", model: "local-whisper" } });
});

it("shows save failures and keeps the credential draft for retry", async () => {
  fixture.api.mockRejectedValueOnce(new Error("Cannot save this address"));
  await select(0, "openai");
  await input("password", "retry-key");
  await enterModel("custom-transcriber");
  await save();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Cannot save this address");
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("retry-key");
});

it("saves a desktop key and its endpoint in one credential write", async () => {
  const setCredential = vi.fn(async () => fixture.config);
  window.ogb = { setCredential } as unknown as Window["ogb"];
  try {
    await select(0, "openai");
    await select(1, "groq");
    await input("password", "desktop-secret");
    await enterModel("whisper-fixture");
    await save();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledWith("sttKey", "desktop-secret", { provider: "openai", ...STT_PRESETS.groq, model: "whisper-fixture" });
  } finally { delete window.ogb; }
});

it("leaves the saved endpoint alone when the desktop key write is refused", async () => {
  const setCredential = vi.fn(async () => { throw new Error("A key can only be sent to an https:// address or a server on this computer."); });
  window.ogb = { setCredential } as unknown as Window["ogb"];
  try {
    await select(0, "openai");
    await select(1, "custom");
    await input("url", "http://192.168.1.5:8000");
    await input("password", "lan-key");
    await enterModel("whisper");
    await save();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("https://");
  } finally { delete window.ogb; }
});

it.each(["openai", "groq", "google"])("loads %s models with the draft credential without saving configuration", async (service) => {
  await select(0, service === "google" ? "gemini" : "openai");
  if (service === "groq") await select(1, "groq");
  const candidates = [`${service}-chat-model`, `${service}-whisper-large`];
  fixture.api.mockResolvedValueOnce({ models: candidates });
  await input("password", `${service}-draft-key`);
  await act(async () => host.querySelector<HTMLButtonElement>("[data-stt-load-models]")!.click());
  expect(fixture.api).toHaveBeenCalledOnce();
  expect(fixture.api.mock.calls[0]![0]).toBe("/api/tts/models");
  expect(JSON.parse(fixture.api.mock.calls[0]![1].body)).toEqual({ stt: {
    provider: service === "google" ? "gemini" : "openai", baseUrl: STT_PRESETS[service as keyof typeof STT_PRESETS].baseUrl, key: `${service}-draft-key`,
  } });
  expect([...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"))).toEqual(candidates);
  expect(fixture.dispatch).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe(`${service}-whisper-large`);
});

it("leaves the model empty when no loaded model is named for transcription", async () => {
  await select(0, "openai");
  fixture.api.mockResolvedValueOnce({ models: ["gpt-4o", "llama-3"] });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-stt-load-models]")!.click());
  expect(host.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe("");
});

it("keeps a typed model when models load", async () => {
  await select(0, "openai");
  await enterModel("my-model");
  fixture.api.mockResolvedValueOnce({ models: ["other-model"] });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-stt-load-models]")!.click());
  expect(host.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe("my-model");
});

it("keeps manual model entry available after discovery fails", async () => {
  await select(0, "openai");
  fixture.api.mockRejectedValueOnce(new Error("No model catalog here"));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-stt-load-models]")!.click());
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("No model catalog here");
  await enterModel("my-new-audio-model");
  await save();
  expect(JSON.parse(fixture.api.mock.calls[1]![1].body).stt.model).toBe("my-new-audio-model");
});

it("discards a late model catalog when the provider changes", async () => {
  await select(0, "openai");
  let finish!: (value: { models: string[] }) => void;
  fixture.api.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-stt-load-models]")!.click());
  await select(0, "gemini");
  await act(async () => finish({ models: ["wrong-provider-model"] }));
  expect(host.querySelectorAll("datalist option")).toHaveLength(0);
});

it("says why a saved key is not used", async () => {
  fixture.config = { stt: { provider: "openai", baseUrl: "https://stt.example.com/v1", model: "whisper", configured: true, keyConfigured: false, keyIgnored: true } };
  await act(async () => root.render(createElement(SpeechInputSettings)));
  expect(host.querySelector('[role="status"]')!.textContent).toBe(t("stt.keyIgnored"));
  await input("password", "fresh-key");
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("keeps a key typed before the address is edited", async () => {
  await select(0, "openai");
  await select(1, "custom");
  await input("password", "pasted-first");
  await input("url", "http://whisper:8000/v1");
  await enterModel("whisper-1");
  await save();
  expect(JSON.parse(fixture.api.mock.calls[0]![1].body)).toEqual({ stt: { provider: "openai", baseUrl: "http://whisper:8000/v1", model: "whisper-1", key: "pasted-first" } });
});
