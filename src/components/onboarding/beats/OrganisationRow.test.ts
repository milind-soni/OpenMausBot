import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDesktopBridge, ManagedDesktopState } from "../../../../electron/managed-desktop.mjs";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
import { OrganisationRow } from "./OrganisationRow";

type Node = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function text(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return isValidElement(value) ? text((value as Node).props.children) : "";
}

let bridge: ManagedDesktopBridge;
let push: (state: ManagedDesktopState) => void;
let unsubscribe = vi.fn<() => void>();
const onOpenSettings = vi.fn();
const onConnected = vi.fn();

function render() {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = OrganisationRow({ bridge, onOpenSettings, onConnected });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const button = (label: string) => render().nodes.find((node) => node.type === "button" && text(node.props.children) === label);
async function mount(state: ManagedDesktopState = { status: "signed-out" }) {
  vi.mocked(bridge.state).mockResolvedValueOnce(state);
  render();
  const cleanup = fixture.effects[0]!();
  await flush();
  return cleanup;
}

const connecting: ManagedDesktopState = {
  status: "connecting",
  enrollment: { userCode: "ABCDE-FGHIJ", verificationUri: "https://admin.openmausbot.com/enroll?code=ABCDE-FGHIJ", expiresAt: Date.now() + 60_000 },
};
const connected: ManagedDesktopState = {
  status: "connected",
  organization: { id: "fixture-org", name: "Fixture Company" },
  email: "employee@example.test",
  providers: [
    { id: "anthropic", configured: true, models: ["model-a", "model-b"] },
    { id: "openrouter", configured: true, models: ["model-c"] },
    { id: "openai", configured: false, models: [] },
  ],
};

beforeEach(() => {
  fixture.values = [];
  fixture.index = 0;
  fixture.effects = [];
  unsubscribe = vi.fn();
  push = () => {};
  onOpenSettings.mockReset();
  onConnected.mockReset();
  bridge = {
    settingsOpened: vi.fn().mockResolvedValue(true),
    state: vi.fn().mockResolvedValue({ status: "signed-out" }),
    begin: vi.fn().mockResolvedValue(connecting),
    cancelEnrollment: vi.fn().mockResolvedValue({ status: "signed-out" }),
    refresh: vi.fn().mockResolvedValue(connected),
    disconnect: vi.fn().mockResolvedValue({ status: "signed-out" }),
    onState: vi.fn((callback) => {
      push = callback;
      return unsubscribe;
    }),
  };
  vi.stubGlobal("fetch", vi.fn());
  setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("organisation sign-in row in the welcome flow", () => {
  it("offers sign-in without starting it, and never touches Settings' own acknowledgement", async () => {
    expect(render().html).toBe("");
    await mount();
    const html = render().html;
    expect(html).toContain("Using OpenMausBot at work?");
    expect(html).toContain("Sign in with your organisation.");
    expect(html).toContain("Other Admin address");
    expect(bridge.begin).not.toHaveBeenCalled();
    expect(bridge.settingsOpened).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs in to the default Admin once, then follows the browser step to connected", async () => {
    await mount();
    const signIn = button("Sign in")!;
    signIn.props.onClick!();
    signIn.props.onClick!();
    await flush();
    expect(bridge.begin).toHaveBeenCalledExactlyOnceWith({ portalOrigin: "https://admin.openmausbot.com" });

    let html = render().html;
    expect(html).toContain("Finish in your browser");
    expect(html).toContain("ABCDE-FGHIJ");
    expect(html).not.toContain("Using OpenMausBot at work?");
    expect(onConnected).not.toHaveBeenCalled();

    push(connected);
    html = render().html;
    expect(html).toContain("Signed in to Fixture Company");
    expect(html).toContain("Company models: 3");
    expect(html).not.toContain("ABCDE-FGHIJ");
    expect(onConnected).toHaveBeenCalledOnce();
    // a heartbeat with the same state does not count again
    push(connected);
    expect(onConnected).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can cancel a sign-in in progress", async () => {
    await mount(connecting);
    button("Cancel sign-in")!.props.onClick!();
    await flush();
    expect(bridge.cancelEnrollment).toHaveBeenCalledOnce();
    expect(render().html).toContain("Using OpenMausBot at work?");
  });

  it("sends another Admin address to Settings instead of asking here", async () => {
    await mount();
    button("Other Admin address")!.props.onClick!();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(bridge.begin).not.toHaveBeenCalled();
  });

  it("says when the organisation has approved no models yet", async () => {
    await mount({ ...connected, providers: [] });
    const html = render().html;
    expect(html).toContain("Signed in to Fixture Company");
    expect(html).toContain("No company models are available yet");
    // already connected when the beat opened: nothing new to count
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("points any other state to Settings with no sign-in button", async () => {
    await mount({ ...connected, status: "reauth-required", message: "Fixture reason" });
    const html = render().html;
    expect(html).toContain("Fixture Company");
    expect(html).toContain("Fixture reason");
    expect(button("Sign in")).toBeUndefined();
    button("Organisation settings")!.props.onClick!();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows product copy for a failed action, never the IPC error", async () => {
    await mount();
    vi.mocked(bridge.begin).mockRejectedValueOnce(new Error("Private /path token-secret"));
    button("Sign in")!.props.onClick!();
    await flush();
    const html = render().html;
    expect(html).toContain("Could not complete this action");
    expect(html).not.toContain("token-secret");
  });

  it("unsubscribes and ignores late answers once the beat closes", async () => {
    const cleanup = await mount();
    let resolveBegin!: (state: ManagedDesktopState) => void;
    vi.mocked(bridge.begin).mockImplementation(() => new Promise((resolve) => { resolveBegin = resolve; }));
    button("Sign in")!.props.onClick!();
    if (typeof cleanup === "function") cleanup();
    push(connected);
    resolveBegin(connecting);
    await flush();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(render().html).not.toContain("Fixture Company");
    expect(render().html).not.toContain("ABCDE-FGHIJ");
    expect(onConnected).not.toHaveBeenCalled();
  });
});
