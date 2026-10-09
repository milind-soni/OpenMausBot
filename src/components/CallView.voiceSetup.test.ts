// When a call can't start for want of a voice, the call button's help offers
// "Set up voice", which opens a pop-up over the chat instead of the bot's
// full settings. Same hook-by-call-order harness as
// BotSettingsDialog.simple.test.ts: component state survives between renders,
// effects never run, and handlers are read off the returned element tree.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  own: 0,
  onCall: null as string | null,
  dictation: { available: true } as Record<string, unknown>,
  config: { tts: { configured: false } } as Record<string, unknown> | null,
  bots: [] as unknown[],
  dispatch: vi.fn(),
  startCall: vi.fn(),
  endCall: vi.fn(),
  track: vi.fn(),
  dialog: null as Record<string, unknown> | null,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config, bots: fixture.bots }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  // the Mac app: only a Mac is sent to This computer for a call
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" }, dictation: fixture.dictation }, ready: true }),
}));
vi.mock("@/lib/call", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/call")>(),
  startCall: fixture.startCall,
  endCall: fixture.endCall,
  useOnCall: () => fixture.onCall,
}));
vi.mock("@/lib/local-voice", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/local-voice")>(),
  localSystemVoiceActive: () => false,
}));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
// The help card shows exactly while it is open; no exit animation to wait out.
vi.mock("./MenuMotion", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MenuMotion")>(),
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./VoiceSetupDialog", () => ({
  VoiceSetupDialog: (props: Record<string, unknown>) => {
    fixture.dialog = props;
    return createElement("div", { "data-voice-setup-stub": (props.bot as Bot).id });
  },
}));

const { CallButton, CallTargetButton } = await import("./CallView");
const { configureLiveMedia, liveMedia, resetLiveMedia } = await import("@/lib/live-call-media");

const pepper: Bot = {
  id: "pepper", threadId: "t", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [],
  modelSelection: { instanceId: "codex", model: "m" },
};
const basil: Bot = { ...pepper, id: "basil", threadId: "t2", name: "Basil", voice: "voice-1" };

type Props = Parameters<typeof CallTargetButton>[0];
type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

/** The composer's call button for Pepper, unless a room's props are given. */
function render(props?: Props) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  fixture.dialog = null;
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    const element = CallButton({ bot: pepper, placement: "composer" }) as ReactElement<Props>;
    tree = CallTargetButton(props ?? element.props);
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const find = (rendered: { nodes: Node[] }, attribute: string) =>
  rendered.nodes.find((node) => node.props[attribute] !== undefined)!;
const click = (node: Node) => (node.props.onClick as () => void)();

/** Click the call button, then the help's "Set up voice". */
function openVoiceSetup(props?: Props) {
  click(find(render(props), "data-call-button"));
  const help = render(props);
  expect(help.html).toContain("Call unavailable");
  click(find(help, "data-voice-setup-open"));
  return render(props);
}

beforeEach(() => {
  fixture.values = [];
  fixture.own = 0;
  fixture.onCall = null;
  fixture.dictation = { available: true };
  fixture.config = { tts: { configured: false } };
  fixture.bots = [pepper, basil];
  fixture.dispatch.mockClear();
  fixture.startCall.mockClear();
  fixture.endCall.mockClear();
  fixture.track.mockClear();
  vi.stubGlobal("window", { ogb: { speechStart: () => {} } });
});
afterEach(() => {
  resetLiveMedia();
  vi.unstubAllGlobals();
});

describe("setting up a voice from the call button", () => {
  it("offers Set up voice in the help, which opens the pop-up instead of the bot's settings", () => {
    const closed = render();
    expect(closed.html).not.toContain("Call unavailable");
    click(find(closed, "data-call-button"));

    const help = render();
    expect(help.html).toContain("Set up a voice in an agent profile to make calls");
    expect(help.html).toContain("Set up voice");
    expect(help.html).not.toContain("Open agent settings");
    const setUp = find(help, "data-voice-setup-open");
    expect(setUp.props["aria-haspopup"]).toBe("dialog");
    expect(String(setUp.props.className).split(" ")).toEqual(expect.arrayContaining(["bg-accent", "text-accent-ink"]));
    expect(help.html).not.toContain("data-voice-setup-stub");
    click(setUp);
    expect(fixture.dispatch).not.toHaveBeenCalled();

    const opened = render();
    expect(opened.html).not.toContain("Call unavailable");
    expect(opened.html).toContain('data-voice-setup-stub="pepper"');
    expect(fixture.dialog).toMatchObject({ bot: pepper, callName: "Pepper", ready: false });
    // Focus goes back to the call button, not to the help that has gone.
    expect(fixture.dialog!.returnFocusRef).toBe(find(opened, "data-call-button").props.ref);
    expect(fixture.startCall).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("closes the pop-up and leaves the call button as it was", () => {
    openVoiceSetup();
    (fixture.dialog!.onClose as () => void)();
    const after = render();
    expect(after.html).not.toContain("data-voice-setup-stub");
    expect(after.html).not.toContain("Call unavailable");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("tells the pop-up when a voice is ready, and starts the call the way the button does", () => {
    openVoiceSetup();
    expect(fixture.dialog!.ready).toBe(false);
    // the key was saved and a voice picked, inside the pop-up
    fixture.config = { tts: { configured: true, ready: true } };
    const ready = render();
    expect(ready.html).toContain('data-voice-setup-stub="pepper"');
    expect(fixture.dialog!.ready).toBe(true);

    (fixture.dialog!.onStartCall as () => void)();
    expect(fixture.track).toHaveBeenCalledWith("call_started", { driver: "codex", mode: "turns" });
    expect(fixture.startCall).toHaveBeenCalledWith("pepper");
    expect(render().html).not.toContain("data-voice-setup-stub");
  });

  it("does the same from a room's header button, member by member", () => {
    // GroupCallButton's props: the first member without a voice, else the first.
    const room: Props = {
      targetId: "room-1",
      targetName: "Standup",
      voices: [undefined, undefined],
      setupBotId: "pepper",
      requireExplicitVoices: true,
      onStart: () => fixture.track("group_call_started", { memberCount: 2 }),
    };
    fixture.config = { tts: { configured: true, ready: true } };
    const opened = openVoiceSetup(room);
    expect(String(find(opened, "data-call-button").props.className).split(" ")).toContain("size-9");
    expect(fixture.dialog).toMatchObject({ bot: pepper, callName: "Standup", ready: false });

    // Pepper gets a voice; the pop-up moves on to Basil.
    room.voices = ["voice-2", undefined];
    room.setupBotId = "basil";
    render(room);
    expect(fixture.dialog).toMatchObject({ bot: basil, ready: false });

    // Basil too: the room can be called, and the pop-up stays on Basil
    // rather than jumping back to the room's fallback member.
    room.voices = ["voice-2", "voice-3"];
    room.setupBotId = "pepper";
    render(room);
    expect(fixture.dialog).toMatchObject({ bot: basil, ready: true });
    (fixture.dialog!.onStartCall as () => void)();
    expect(fixture.track).toHaveBeenCalledWith("group_call_started", { memberCount: 2 });
    expect(fixture.startCall).toHaveBeenCalledWith("room-1");
  });

  it("opens the remote agent settings instead on a desktop paired to another computer", () => {
    // This Mac speaks with the host's voices; the host has a key but no
    // default voice, and Pepper has none of its own.
    vi.stubGlobal("window", { ogb: { speechStart: () => {}, remoteClient: { active: true } } });
    fixture.config = { tts: { configured: true, ready: false } };
    click(find(render(), "data-call-button"));
    const help = render();
    expect(help.html).toContain("Set up voice");
    const setUp = find(help, "data-voice-setup-open");
    // A side panel, not a dialog.
    expect(setUp.props["aria-haspopup"]).toBeUndefined();
    click(setUp);
    // The pop-up's saves (the bot update, the voice config) are refused by
    // the pairing; the remote agent settings save through the host's
    // profile route, so the button opens those, as it always did.
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "toggleSettings", open: true, section: "voice" }]]);
    const after = render();
    expect(after.html).not.toContain("data-voice-setup-stub");
    expect(after.html).not.toContain("Call unavailable");
    expect(fixture.dialog).toBeNull();
    expect(fixture.startCall).not.toHaveBeenCalled();
  });

  it("opens the member's chat first from a room on a paired desktop", () => {
    vi.stubGlobal("window", { ogb: { speechStart: () => {}, remoteClient: { active: true } } });
    fixture.config = { tts: { configured: true, ready: true } };
    const room: Props = {
      targetId: "room-1",
      targetName: "Standup",
      voices: ["voice-1", undefined],
      setupBotId: "pepper",
      requireExplicitVoices: true,
      onStart: () => {},
    };
    click(find(render(room), "data-call-button"));
    click(find(render(room), "data-voice-setup-open"));
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: "pepper" }],
      [{ type: "toggleSettings", open: true, section: "voice" }],
    ]);
    expect(render(room).html).not.toContain("data-voice-setup-stub");
  });

  // A server's page can't take turns, so a missing voice is no reason to
  // stop: the call is Live. Its first press asks for the microphone (then,
  // if the server has no key, for the key), never for a voice.
  it("starts the Live call, not voice set-up, where the device can't take turns", () => {
    fixture.dictation = { available: false, reasonCode: "remote-server" };
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    configureLiveMedia({ getUserMedia });
    click(find(render(), "data-call-button"));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "pepper", threadId: "t" });
    expect(fixture.track).toHaveBeenCalledWith("call_started", { driver: "codex", mode: "live" });
    const after = render();
    expect(after.html).not.toContain("Set up voice");
    expect(after.html).not.toContain("Call unavailable");
    expect(after.html).not.toContain("Choose This computer");
    expect(fixture.dialog).toBeNull();
  });
});
