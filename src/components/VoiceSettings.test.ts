// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  config: { tts: { configured: true, provider: "elevenlabs", voice: "" } } as Record<string, unknown>,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: vi.fn() }),
}));

const { VoiceSettings } = await import("./VoiceSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIBRARY = { id: "lib-1", label: "Library Rachel", description: "irish", publicOwnerId: "owner2" };
const bot = (id: string): Bot => ({
  id, threadId: "t", name: id, title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId: "codex", model: "m" },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.config = { tts: { configured: true, provider: "elevenlabs", voice: "" } };
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  fixture.api.mockReset();
});

function addLater() {
  let resolve!: (value: { voiceId: string }) => void;
  const added = new Promise<{ voiceId: string }>((done) => (resolve = done));
  fixture.api.mockImplementation((path: string) =>
    path === "/api/tts/voices/add" ? added : Promise.resolve({ voices: [LIBRARY] }));
  return resolve;
}

const render = (forBot: Bot, onPatch: (patch: Record<string, unknown>) => void) =>
  act(async () => root.render(createElement(VoiceSettings, { bot: forBot, onPatch })));
const trigger = () => host.querySelector<HTMLButtonElement>("[data-voice-picker]")!;

async function pickLibraryVoice() {
  await act(async () => trigger().click());
  const row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("Library Rachel"))!;
  await act(async () => row.click());
}

describe("VoiceSettings", () => {
  it("sets a library voice once ElevenLabs has added it, and says it is adding meanwhile", async () => {
    const resolve = addLater();
    const onPatch = vi.fn();
    await render(bot("pepper"), onPatch);
    await pickLibraryVoice();

    expect(fixture.api).toHaveBeenCalledWith("/api/tts/voices/add", expect.objectContaining({ method: "POST" }));
    expect(trigger().textContent).toContain("Adding…");
    await act(async () => resolve({ voiceId: "added-1" }));
    expect(onPatch).toHaveBeenCalledWith({ voice: "added-1" });
    expect(trigger().disabled).toBe(false);
  });

  it("drops an add that settles after the bot changed, so it never lands on the wrong bot", async () => {
    const resolve = addLater();
    const onPatch = vi.fn();
    await render(bot("pepper"), onPatch);
    await pickLibraryVoice();

    await render(bot("salt"), onPatch);
    expect(trigger().textContent).not.toContain("Adding…");
    await act(async () => resolve({ voiceId: "added-1" }));
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("lays the seven voice services out four to a row, OpenAI beside the other online services", async () => {
    fixture.api.mockResolvedValue({ voices: [] });
    await render(bot("pepper"), vi.fn());
    const radios = [...host.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(["ElevenLabs", "Fish Audio", "OpenAI", "Grok (xAI)", "Gemini", "Built-in Mac voices", "Chatterbox (local)"]);
    expect(radios.map((radio) => radio.className.match(/col-span-\d/)?.[0])).toEqual([
      "col-span-1", "col-span-1", "col-span-1", "col-span-1", "col-span-1", "col-span-1", "col-span-1",
    ]);
  });
});


describe("OpenAI voice settings", () => {
  const openaiRadio = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent === "OpenAI")!;
  it("selects marin only after the person chooses OpenAI, without enabling readout", async () => {
    fixture.api.mockResolvedValue({ tts: { provider: "openai", configured: true }, voices: [] });
    const onPatch = vi.fn();
    await render({ ...bot("pepper"), voice: "elevenlabs-voice" }, onPatch);
    expect(onPatch).not.toHaveBeenCalled();
    await act(async () => openaiRadio().click());
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ tts: { provider: "openai" } }) });
    expect(onPatch).toHaveBeenCalledExactlyOnceWith({ voice: "marin" });
  });
  it("preserves an already selected OpenAI voice", async () => {
    fixture.api.mockResolvedValue({ voices: [] });
    const onPatch = vi.fn();
    await render({ ...bot("pepper"), voice: "cedar" }, onPatch);
    await act(async () => openaiRadio().click());
    expect(onPatch).not.toHaveBeenCalled();
  });
  it("does not assign a voice to another bot if it changes while saving the provider", async () => {
    let resolve!: (v: unknown) => void;
    fixture.api.mockImplementation((path) => path === "/api/config" ? new Promise((done) => { resolve = done; }) : Promise.resolve({ voices: [] }));
    const onPatch = vi.fn();
    await render(bot("pepper"), onPatch);
    await act(async () => openaiRadio().click());
    await render(bot("salt"), onPatch);
    await act(async () => resolve({ tts: { provider: "openai" } }));
    expect(onPatch).not.toHaveBeenCalled();
  });
  it("links a missing key to the existing API key settings and discloses billing and AI voices", async () => {
    fixture.config = { tts: { provider: "openai", configured: false } };
    fixture.api.mockResolvedValue({ voices: [] });
    await render(bot("pepper"), vi.fn());
    expect(host.textContent).toContain("AI-generated");
    expect(host.textContent).toContain("billed by OpenAI");
    expect(host.textContent).toContain("Live call settings are separate");
    expect(host.textContent).toContain("Add an OpenAI API key");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });
});


it("sets the default voice even when the provider broadcast arrives before the save response", async () => {
  let resolve!: (v: unknown) => void;
  fixture.api.mockImplementation((path) => path === "/api/config" ? new Promise((done) => { resolve = done; }) : Promise.resolve({ voices: [] }));
  const onPatch = vi.fn();
  const pepper = bot("pepper");
  await render(pepper, onPatch);
  const radio = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent === "OpenAI")!;
  await act(async () => radio.click());
  fixture.config = { tts: { provider: "openai", configured: true } };
  await render(pepper, onPatch);
  await act(async () => resolve({ tts: { provider: "openai", configured: true } }));
  expect(onPatch).toHaveBeenCalledExactlyOnceWith({ voice: "marin" });
});

it("keeps a voice selected before the pending provider save completes, even before bot props update", async () => {
  let resolve!: (v: unknown) => void;
  fixture.api.mockImplementation((path) => path === "/api/config"
    ? new Promise((done) => { resolve = done; })
    : Promise.resolve({ voices: [{ id: "cedar", label: "Cedar" }, { id: "marin", label: "Marin" }] }));
  const onPatch = vi.fn();
  const pepper = bot("pepper");
  await render(pepper, onPatch);
  const radio = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent === "OpenAI")!;
  await act(async () => radio.click());
  fixture.config = { tts: { provider: "openai", configured: true } };
  await render(pepper, onPatch);
  const picker = host.querySelector<HTMLSelectElement>('select[data-voice-picker]')!;
  await act(async () => { picker.value = "cedar"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => resolve({ tts: { provider: "openai", configured: true } }));
  expect(onPatch).toHaveBeenCalledExactlyOnceWith({ voice: "cedar" });
});
