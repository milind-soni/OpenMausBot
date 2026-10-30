import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  onCall: null as string | null,
  dictation: true,
  host: "darwin" as "darwin" | "win32",
  serverPage: false,
  config: { tts: { configured: true, ready: true } } as Record<string, unknown> | null,
  bots: [] as unknown[],
  helpShown: false,
  dispatch: vi.fn(),
  startCall: vi.fn(),
  endCall: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config, bots: fixture.bots, instances: [{ instanceId: "codex", driverKind: "codex" }, { instanceId: "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c", driverKind: "claudeAgent" }] }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: fixture.host },
      dictation: fixture.dictation
        ? { available: true }
        : { available: false, reasonCode: fixture.serverPage ? "remote-server" : "unsupported-platform" },
    },
    ready: true,
  }),
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
// Stands in for the open state a click would set; SSR cannot click.
vi.mock("./MenuMotion", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MenuMotion")>(),
  useMenuMotion: (open: boolean) => ({ shown: open || fixture.helpShown, closing: false, className: "", exitProps: {} }),
}));

const { CallButton, CallTargetButton } = await import("./CallView");
const { configureLiveMedia, liveMedia, resetLiveMedia } = await import("@/lib/live-call-media");

const bot: Bot = {
  id: "pepper", threadId: "t", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], voice: "voice-1",
  modelSelection: { instanceId: "codex", model: "m" },
};

type Props = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };
function findButton(tree: ReactNode): ReactElement<Props> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<Props>(child)) continue;
    if (child.type === "button" && child.props["data-call-button"]) return child;
    const found = findButton(child.props.children);
    if (found) return found;
  }
}

function render(placement: "composer" | "header" = "composer") {
  let tree: ReactNode = null;
  function Capture() {
    const element = CallButton({ bot, placement }) as ReactElement<Parameters<typeof CallTargetButton>[0]>;
    tree = CallTargetButton(element.props);
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, button: findButton(tree)! };
}

beforeEach(() => {
  fixture.onCall = null;
  fixture.dictation = true;
  fixture.host = "darwin";
  fixture.serverPage = false;
  fixture.config = { tts: { configured: true, ready: true } };
  fixture.bots = [bot];
  fixture.helpShown = false;
  fixture.startCall.mockClear();
  fixture.endCall.mockClear();
  fixture.track.mockClear();
  fixture.dispatch.mockClear();
  vi.stubGlobal("window", { ogb: { speechStart: () => {} } });
});
afterEach(() => {
  resetLiveMedia();
  vi.unstubAllGlobals();
});

describe("composer call button", () => {
  it("is a Send-sized filled button with a waveform, labelled for the bot", () => {
    const { html, button } = render();
    expect(button.props["aria-label"]).toBe("Call Pepper");
    expect(String(button.props.className).split(" ")).toEqual(expect.arrayContaining(["size-8", "rounded-l-3xl", "rounded-r-lg", "active:rounded-3xl", "transition-[color,background,border-radius]", "bg-control"]));
    expect(html).toContain("lucide-audio-lines");
    expect(html).not.toContain("lucide-phone");
  });

  it("starts the call with the same telemetry as the header button did", () => {
    render().button.props.onClick!();
    expect(fixture.track).toHaveBeenCalledWith("call_started", { driver: "codex", mode: "turns" });
    expect(fixture.startCall).toHaveBeenCalledWith("pepper");
    expect(fixture.endCall).not.toHaveBeenCalled();
  });

  it("names the engine, never the instance id, for an added account", () => {
    const added = { ...bot, modelSelection: { instanceId: "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c", model: "m" } };
    let tree: ReactNode = null;
    function Capture() {
      const element = CallButton({ bot: added }) as ReactElement<Parameters<typeof CallTargetButton>[0]>;
      tree = CallTargetButton(element.props);
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    findButton(tree)!.props.onClick!();
    expect(fixture.track.mock.calls).toEqual([["call_started", { driver: "claude", mode: "turns" }]]);
  });

  it("shows a hang-up state during the call and hangs up", () => {
    fixture.onCall = "pepper";
    const { html, button } = render();
    expect(button.props["aria-label"]).toBe("Hang up on Pepper");
    expect(String(button.props.className)).toContain("bg-danger");
    expect(html).toContain("lucide-phone-off");
    button.props.onClick!();
    expect(fixture.endCall).toHaveBeenCalledWith("pepper");
    expect(fixture.startCall).not.toHaveBeenCalled();
  });

  it("explains missing voice setup in a help popover that opens upward, instead of calling", () => {
    fixture.config = { tts: { configured: false } };
    fixture.helpShown = true;
    const { html, button } = render();
    expect(button.props["aria-label"]).toBe("Set up a voice in an agent profile to make calls");
    expect(button.props["aria-controls"]).toBeTruthy();
    expect(html).toContain("Call unavailable");
    expect(html).toContain("Set up voice");
    expect(html).not.toContain("Open agent settings");
    expect(html).toMatch(/role="group" aria-label="Call unavailable" class="[^"]*\bbottom-full\b/);
    button.props.onClick!();
    expect(fixture.startCall).not.toHaveBeenCalled();
  });

  it("is a Live call on a device that can't take turns", () => {
    fixture.dictation = false;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    configureLiveMedia({ getUserMedia });
    const { html, button } = render();
    expect(button.props["aria-label"]).toBe("Live call with Pepper");
    expect(html).not.toContain("bg-warning");
    button.props.onClick!();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "pepper" });
    expect(fixture.track).toHaveBeenCalledWith("call_started", { driver: "codex", mode: "live" });
  });

  it("is a Live call on a server's page in the Windows app and the Mac app alike", () => {
    fixture.dictation = false;
    fixture.serverPage = true;
    for (const host of ["win32", "darwin"] as const) {
      fixture.host = host;
      const { html, button } = render();
      expect(button.props["aria-label"], host).toBe("Live call with Pepper");
      expect(html, host).not.toContain("bg-warning");
      expect(html, host).not.toContain("Call unavailable");
      expect(html, host).not.toContain("Choose This computer");
    }
  });

  it("is a 28px circle filled with the bot's tone, its glyph in the tone's ink, in the Simple composer, the call mode left to the bot panel", () => {
    let tree: ReactNode = null;
    function Capture() {
      const element = CallButton({ bot, placement: "composer", fill: "#8057c8", ink: "#ffffff" }) as ReactElement<Parameters<typeof CallTargetButton>[0]>;
      tree = CallTargetButton(element.props);
      return tree;
    }
    const html = renderToStaticMarkup(createElement(Capture));
    const button = findButton(tree)!;
    const classes = String(button.props.className).split(" ");
    expect(classes).toEqual(expect.arrayContaining(["size-7", "rounded-full"]));
    expect(classes).not.toContain("text-white");
    expect(classes).not.toContain("rounded-l-3xl");
    expect(classes).not.toContain("bg-control");
    expect(button.props.style).toEqual({ backgroundColor: "#8057c8", color: "#ffffff" });
    expect(html).toContain("lucide-audio-lines");
    expect(html).not.toContain('aria-label="Call mode"');
    expect(renderToStaticMarkup(createElement(() => CallButton({ bot, placement: "composer" })))).toContain('aria-label="Call mode"');
  });

  it("drops the bot's colour for the red hang-up during a call", () => {
    fixture.onCall = "pepper";
    let tree: ReactNode = null;
    function Capture() {
      const element = CallButton({ bot, placement: "composer", fill: "#8057C8" }) as ReactElement<Parameters<typeof CallTargetButton>[0]>;
      tree = CallTargetButton(element.props);
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    const button = findButton(tree)!;
    expect(String(button.props.className)).toContain("bg-danger");
    expect(button.props.style).toBeUndefined();
  });

  it("leaves the header placement (rooms) as it was", () => {
    fixture.helpShown = true;
    fixture.config = { tts: { configured: false } };
    const { html, button } = render("header");
    expect(String(button.props.className).split(" ")).toContain("size-9");
    expect(html).toContain("lucide-phone");
    expect(html).not.toMatch(/role="group" aria-label="Call unavailable" class="[^"]*\bbottom-full\b/);
  });
});
