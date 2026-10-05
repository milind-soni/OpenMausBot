// A bot's call button lives in the composer, beside dictation: a filled circle
// the size of Send with a waveform in it. It keeps the header button's
// behaviour exactly — start, hang up, and the help when a call can't start.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  onCall: null as string | null,
  dictation: true,
  /** the desktop this page runs in, and whether the page is a server's */
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
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config, bots: fixture.bots }, dispatch: fixture.dispatch }) };
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
// Stand in for the open state a click would set; SSR cannot click.
vi.mock("./MenuMotion", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MenuMotion")>(),
  useMenuMotion: (open: boolean) => ({ shown: open || fixture.helpShown, closing: false, className: "", exitProps: {} }),
}));

const { CallButton, CallTargetButton } = await import("./CallView");

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
afterEach(() => { vi.unstubAllGlobals(); });

describe("composer call button", () => {
  it("is a Send-sized filled circle with a waveform, labelled for the bot", () => {
    const { html, button } = render();
    expect(button.props["aria-label"]).toBe("Call Pepper");
    expect(String(button.props.className).split(" ")).toEqual(expect.arrayContaining(["size-8", "rounded-full", "bg-control"]));
    expect(html).toContain("lucide-audio-lines");
    expect(html).not.toContain("lucide-phone");
  });

  it("starts the call with the same telemetry as the header button did", () => {
    render().button.props.onClick!();
    expect(fixture.track).toHaveBeenCalledWith("call_started", { driver: "codex", mode: "turns" });
    expect(fixture.startCall).toHaveBeenCalledWith("pepper");
    expect(fixture.endCall).not.toHaveBeenCalled();
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
    // Voice set-up is a pop-up now, not a trip to the bot's full settings
    // (CallView.voiceSetup.test.ts covers it).
    expect(html).toContain("Set up voice");
    expect(html).not.toContain("Open agent settings");
    expect(html).toMatch(/role="group" aria-label="Call unavailable" class="[^"]*\bbottom-full\b/);
    button.props.onClick!();
    expect(fixture.startCall).not.toHaveBeenCalled();
  });

  it("keeps the same availability rules on devices that cannot call", () => {
    fixture.dictation = false;
    const { button } = render();
    expect(button.props["aria-label"]).toBe("Calls where you take turns need the Mac app");
    button.props.onClick!();
    expect(fixture.startCall).not.toHaveBeenCalled();
  });

  // A Windows desktop showing a server (its Cloud): This computer can't take
  // turns either, so the help offers a Live call and no trip there.
  it("offers only a Live call on a server's page in the Windows app", () => {
    fixture.dictation = false;
    fixture.serverPage = true;
    fixture.host = "win32";
    fixture.helpShown = true;
    const windows = render().html;
    expect(windows).toContain("Start a Live call instead");
    expect(windows).not.toContain("Choose This computer");

    // the Mac app still sends a server's page to This computer, which can
    fixture.host = "darwin";
    expect(render().html).toContain("Choose This computer");
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
