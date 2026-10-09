// The voice set-up pop-up the call button opens. Server rendering never runs
// effects, so the one that moves focus and listens for Escape is collected
// and run by hand against stand-in elements.
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  dispatch: vi.fn(),
  selectedId: "pepper" as string | null,
  config: { tts: { configured: false, provider: "elevenlabs" } } as Record<string, unknown> | null,
  voiceSettings: [] as Array<{ bot: { id: string }; onPatch: (patch: Record<string, unknown>) => void }>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("react-dom", () => ({ createPortal: (children: ReactNode) => children }));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return {
    ...store,
    useStore: () => ({
      state: { ...store.initialState, selectedId: fixture.selectedId, config: fixture.config },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("./VoiceSettings", () => ({
  VoiceSettings: (props: { bot: { id: string }; onPatch: (patch: Record<string, unknown>) => void }) => {
    fixture.voiceSettings.push(props);
    return createElement("div", { "data-voice-settings": props.bot.id });
  },
}));
vi.mock("./Avatar", () => ({
  BotAvatar: ({ bot, state }: { bot: Bot; state?: string }) => createElement("span", { "data-avatar": bot.id, "data-state": state }),
}));

const { VoiceSetupDialog } = await import("./VoiceSetupDialog");
const { VoiceSection } = await import("./bot-settings/VoiceSection");
const { useBotSettingsDerived } = await import("./bot-settings/useBotSettingsDerived");

const pepper: Bot = {
  id: "pepper", threadId: "t", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [],
  modelSelection: { instanceId: "codex", model: "m" },
};

type Props = Parameters<typeof VoiceSetupDialog>[0];
type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render(overrides: Partial<Props> = {}) {
  const props: Props = { bot: pepper, callName: "Pepper", ready: false, onClose: vi.fn(), onStartCall: vi.fn(), ...overrides };
  let tree: ReactNode = null;
  function Capture() {
    tree = VoiceSetupDialog(props);
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree), props };
}
const byAttribute = (rendered: { nodes: Node[] }, attribute: string, value?: unknown) =>
  rendered.nodes.find((node) => (value === undefined ? node.props[attribute] !== undefined : node.props[attribute] === value))!;
const click = (node: Node) => (node.props.onClick as () => void)();

/** Just enough of an element for the focus effect. */
class FakeElement {
  focus = vi.fn();
  contains = vi.fn(() => true);
  getClientRects = () => [{}];
  querySelector = vi.fn((_selector: string): FakeElement | null => null);
  querySelectorAll = vi.fn((): FakeElement[] => []);
}
const VOICE_PICKER = "select[data-voice-picker]:not([disabled])";
const FIRST_FIELD = "input:not([disabled]), select:not([disabled])";
/** A pane holding these fields, found the way a browser would. */
function paneWith(fields: { voicePicker?: FakeElement; firstField?: FakeElement }) {
  const pane = new FakeElement();
  pane.querySelector.mockImplementation((selector) =>
    (selector === VOICE_PICKER ? fields.voicePicker : selector === FIRST_FIELD ? fields.firstField : undefined) ?? null,
  );
  return pane;
}

beforeEach(() => {
  fixture.effects = [];
  fixture.voiceSettings = [];
  fixture.selectedId = "pepper";
  fixture.config = { tts: { configured: false, provider: "elevenlabs" } };
  fixture.dispatch.mockClear();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("voice set-up pop-up", () => {
  it("is a glass pop-up holding the bot's own voice settings", () => {
    const { html } = render();
    expect(html).toContain("glass-popup-frame");
    expect(html).toContain("glass-scrim");
    expect(html).toContain("glass-surface");
    expect(html).toMatch(/role="dialog" aria-modal="true"/);
    expect(html).toContain("Give Pepper a voice");
    expect(html).toContain("Choose an engine, add its key if it needs one, then pick a voice.");
    expect(html).toContain('data-voice-settings="pepper"');
    expect(html).toContain('aria-label="Close voice set-up"');
    expect(html).toContain("All voice settings");
    expect(html).not.toContain("Voice is ready");
    expect(fixture.voiceSettings.at(-1)!.bot).toBe(pepper);
  });

  it("saves through the same patch the bot settings' Voice section uses", () => {
    render();
    fixture.voiceSettings.at(-1)!.onPatch({ voice: "voice-2" });
    const fromPopUp = fixture.dispatch.mock.calls.at(-1)![0];
    expect(fromPopUp).toEqual({ type: "updateBot", botId: "pepper", patch: { voice: "voice-2" } });

    function Section() {
      return VoiceSection({ bot: pepper, derived: useBotSettingsDerived(pepper) });
    }
    renderToStaticMarkup(createElement(Section));
    fixture.voiceSettings.at(-1)!.onPatch({ voice: "voice-2" });
    expect(fixture.dispatch.mock.calls.at(-1)![0]).toEqual(fromPopUp);
  });

  it("opens the bot's full settings at Voice from All voice settings, closing itself", () => {
    const view = render();
    click(byAttribute(view, "data-voice-setup-all-settings"));
    expect(view.props.onClose).toHaveBeenCalledOnce();
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "toggleSettings", open: true, section: "voice" }]]);
  });

  it("opens a room member's chat first, as the call help always did", () => {
    fixture.selectedId = "room-1";
    click(byAttribute(render(), "data-voice-setup-all-settings"));
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: "pepper" }],
      [{ type: "toggleSettings", open: true, section: "voice" }],
    ]);
  });

  it("closes from the close button and from a click on the scrim, not from inside", () => {
    const view = render();
    click(byAttribute(view, "aria-label", "Close voice set-up"));
    expect(view.props.onClose).toHaveBeenCalledTimes(1);
    const frame = view.nodes.find((node) => String(node.props.className).split(" ").includes("glass-popup-frame"))!;
    const onMouseDown = frame.props.onMouseDown as (event: { target: unknown; currentTarget: unknown }) => void;
    onMouseDown({ target: {}, currentTarget: frame });
    expect(view.props.onClose).toHaveBeenCalledTimes(1);
    onMouseDown({ target: frame, currentTarget: frame });
    expect(view.props.onClose).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("moves focus to the key field, closes on Escape, and gives focus back to the call button", () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const opener = new FakeElement();
    const callButton = new FakeElement();
    const keyField = new FakeElement();
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("document", { body: {}, activeElement: opener });
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    const view = render({ returnFocusRef: { current: callButton as unknown as HTMLElement } });
    // No key saved yet, so no voice picker: the key field comes first.
    const pane = paneWith({ firstField: keyField });
    (byAttribute(view, "role", "dialog").props.ref as RefObject<unknown>).current = pane;

    const cleanup = fixture.effects.at(-1)!();
    expect(pane.querySelector).toHaveBeenCalledWith(VOICE_PICKER);
    expect(pane.querySelector).toHaveBeenCalledWith(FIRST_FIELD);
    expect(keyField.focus).toHaveBeenCalledOnce();

    // A key some other layer already handled is not ours.
    listeners.get("keydown")!({ key: "Escape", defaultPrevented: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(view.props.onClose).not.toHaveBeenCalled();
    const preventDefault = vi.fn();
    listeners.get("keydown")!({ key: "Escape", defaultPrevented: false, isComposing: false, preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(view.props.onClose).toHaveBeenCalledOnce();

    cleanup?.();
    expect(listeners.has("keydown")).toBe(false);
    expect(callButton.focus).toHaveBeenCalledOnce();
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it("starts on the voice picker once the key is saved, not in the key field", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("document", { body: {}, activeElement: null });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const view = render();
    // The key field stays (to replace the key), ahead of the picker.
    const keyField = new FakeElement();
    const voicePicker = new FakeElement();
    const pane = paneWith({ voicePicker, firstField: keyField });
    (byAttribute(view, "role", "dialog").props.ref as RefObject<unknown>).current = pane;

    fixture.effects.at(-1)!();
    expect(voicePicker.focus).toHaveBeenCalledOnce();
    expect(keyField.focus).not.toHaveBeenCalled();
    expect(pane.focus).not.toHaveBeenCalled();
  });

  it("finds the voice picker where VoiceSettings draws it, which is only once the engine is set up", async () => {
    const actual = await vi.importActual<typeof import("./VoiceSettings")>("./VoiceSettings");
    const card = () => renderToStaticMarkup(createElement(actual.VoiceSettings, { bot: pepper, onPatch: () => {} }));
    const key = 'aria-label="ElevenLabs key"';
    const pickerTag = (html: string) => html.match(/<select\b[^>]*>/g)?.find((tag) => tag.includes("data-voice-picker"));

    // No ElevenLabs key yet: its field, and no picker.
    fixture.config = { tts: { configured: false, provider: "elevenlabs" } };
    const needsKey = card();
    expect(needsKey).toContain(key);
    expect(pickerTag(needsKey)).toBeUndefined();

    // Key saved: the field is still there, first, and Pepper's voice picker
    // follows it.
    fixture.config = { tts: { configured: true, provider: "elevenlabs" } };
    const needsVoice = card();
    const tag = pickerTag(needsVoice);
    expect(tag).toContain('aria-label="Pepper&#x27;s voice"');
    expect(needsVoice.indexOf(key)).toBeGreaterThan(-1);
    expect(needsVoice.indexOf(key)).toBeLessThan(needsVoice.indexOf(tag!));
  });

  it("keeps Tab inside, and brings focus back when it has fallen out", () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const body = new FakeElement();
    const first = new FakeElement();
    const last = new FakeElement();
    const page = { body, activeElement: body as FakeElement };
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("document", page);
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    const view = render();
    const pane = new FakeElement();
    pane.querySelectorAll.mockReturnValue([first, last]);
    pane.contains.mockImplementation((node?: unknown) => node === pane || node === first || node === last);
    (byAttribute(view, "role", "dialog").props.ref as RefObject<unknown>).current = pane;
    fixture.effects.at(-1)!();
    const tab = (shiftKey = false) => {
      const event = { key: "Tab", shiftKey, defaultPrevented: false, isComposing: false, preventDefault: vi.fn() };
      listeners.get("keydown")!(event as unknown as KeyboardEvent);
      return event.preventDefault;
    };

    // The control holding focus went away (an engine switch): back in.
    expect(tab()).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();
    expect(tab(true)).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
    // On the pane itself, too.
    page.activeElement = pane;
    tab();
    expect(first.focus).toHaveBeenCalledTimes(2);
    // And it wraps at both ends.
    page.activeElement = last;
    tab();
    expect(first.focus).toHaveBeenCalledTimes(3);
    page.activeElement = first;
    tab(true);
    expect(last.focus).toHaveBeenCalledTimes(2);
    expect(view.props.onClose).not.toHaveBeenCalled();
  });

  it("says the voice is ready and starts the call from there", () => {
    const view = render({ ready: true, callName: "Standup" });
    expect(view.html).toContain('role="status"');
    expect(view.html).toContain("Voice is ready — you can call Standup now.");
    expect(view.html).toContain('data-state="happy"');
    click(byAttribute(view, "data-voice-setup-start"));
    expect(view.props.onStartCall).toHaveBeenCalledOnce();
    expect(view.props.onClose).not.toHaveBeenCalled();
  });

  it("waits for the voice settings to load instead of showing an empty pop-up", () => {
    fixture.config = null;
    const { html } = render();
    expect(html).toContain("Loading voice settings…");
    expect(html).not.toContain("data-voice-settings");
  });
});
