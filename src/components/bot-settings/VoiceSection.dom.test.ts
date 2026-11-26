// @vitest-environment happy-dom
// A bot's own Live call voice, in a real DOM, on the bot's voice settings beside the read-aloud voice.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { BotEditorStore, initialState, type AppState, type Bot } from "@/state/store";
import type { LiveSettings } from "../../../shared/wire";
import { BotEditorContext } from "./BotEditorContext";
import { VoiceSection } from "./VoiceSection";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

const atlas: Bot = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: true, color: "green",
  unread: false, modelSelection: { instanceId: "claude", model: "test" }, messages: [],
};
const openAiLive: LiveSettings = { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 };

let host: HTMLDivElement;
let root: Root;
const patch = vi.fn();
const render = (live: LiveSettings | undefined, bot: Bot = atlas, draft = false) => {
  const value = { state: { ...initialState, config: { live } as AppState["config"] }, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const derived = { patch } as unknown as ReturnType<typeof useBotSettingsDerived>;
  const section = createElement(VoiceSection, { bot, derived });
  const editor = createElement(BotEditorContext.Provider, { value: { request: vi.fn(), draft }, children: section });
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: editor })));
};
const card = () => host.querySelector("[data-live-call-voice]");
const picker = () => card()?.querySelector("select") ?? null;

beforeEach(() => {
  setLocale("en");
  patch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("a bot's Live call voice in its voice settings", () => {
  it("shows the bot's own call voice and saves a new pick to the same setting the call uses", () => {
    render(openAiLive, { ...atlas, liveVoice: "cedar" });
    expect(card()?.textContent).toContain("Live call voice");
    expect(card()?.textContent).toContain("Voice for Atlas");
    expect(picker()?.value).toBe("cedar");
    picker()!.value = "marin";
    flushSync(() => picker()!.dispatchEvent(new Event("change", { bubbles: true })));
    expect(patch).toHaveBeenCalledWith({ liveVoice: "marin" });
  });

  it("follows the default call voice until the bot has one of the provider's own", () => {
    render(openAiLive);
    expect(picker()?.value).toBe("");
    render({ ...openAiLive, provider: "gemini" }, { ...atlas, liveVoice: "cedar" });
    expect(picker()?.value).toBe("");
    expect([...picker()!.options].map((option) => option.value)).toContain("Kore");
  });

  it("is not there when Live calls are not set up, or the call speaks in its agent's own voice", () => {
    render(undefined);
    expect(card()).toBeNull();
    render({ ...openAiLive, configured: false });
    expect(card()).toBeNull();
    render({ ...openAiLive, provider: "fish" });
    expect(card()).toBeNull();
    render({ ...openAiLive, provider: "elevenlabs" });
    expect(card()).toBeNull();
  });

  it("is not on a bot being created, whose defaults keep no call voice", () => {
    render(openAiLive, atlas, true);
    expect(card()).toBeNull();
  });
});
