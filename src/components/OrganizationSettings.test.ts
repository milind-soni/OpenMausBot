import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDesktopBridge, ManagedDesktopState } from "../../electron/managed-desktop.mjs";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], updating: false,
  store: { bots: [] as unknown[], instances: [] as unknown[], dispatch: (() => {}) as (action: unknown) => void, flushBotPatches: (async () => null) as (botId: string) => Promise<unknown> } }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      if (fixture.updating) throw new Error("A state updater called another state setter");
      fixture.updating = true;
      try { fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next; }
      finally { fixture.updating = false; }
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
// The connected panel reads bots and engines for its Company models section.
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: fixture.store.bots, instances: fixture.store.instances }, dispatch: fixture.store.dispatch, flushBotPatches: fixture.store.flushBotPatches }),
}));
import { OrganizationSettings } from "./OrganizationSettings";
import { CompanyModels } from "./CompanyModels";

type Node = ReactElement<{ children?: ReactNode; disabled?: boolean; value?: string; onChange?: (event: unknown) => void; onSubmit?: (event: unknown) => void; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  // Walk into the Company models section so its inline action is reachable.
  if (node.type === CompanyModels) return [node, ...nodes(CompanyModels(node.props as Parameters<typeof CompanyModels>[0]))];
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render() {
  fixture.index = 0; fixture.effects = [];
  let tree: ReactNode;
  function Capture() { tree = OrganizationSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const button = (label: string) => render().nodes.find(node => node.type === "button" && node.props.children === label)!;
const connected: ManagedDesktopState = {
  status: "connected", organization: { id: "fixture-org", name: "Fixture Company" }, email: "employee@example.test",
  providers: [{ id: "anthropic", configured: true, models: ["model-a", "model-b"] }, { id: "openai", configured: false, models: [] }],
};
const connecting: ManagedDesktopState = { status: "connecting", enrollment: { userCode: "ABCDE-FGHIJ", verificationUri: "https://admin.example.test/enroll", expiresAt: Date.now() + 60_000 } };
let bridge: ManagedDesktopBridge;
let push: (state: ManagedDesktopState) => void;
let unsubscribe = vi.fn<() => void>();
beforeEach(() => {
  fixture.values = []; fixture.index = 0; fixture.effects = []; fixture.updating = false;
  fixture.store = { bots: [], instances: [], dispatch: vi.fn(), flushBotPatches: vi.fn(async () => null) };
  unsubscribe = vi.fn(); push = () => {};
  bridge = {
    settingsOpened: vi.fn().mockResolvedValue(true),
    state: vi.fn().mockResolvedValue({ status: "signed-out" }), begin: vi.fn().mockResolvedValue(connecting),
    reopen: vi.fn().mockResolvedValue(connecting),
    cancelEnrollment: vi.fn().mockResolvedValue({ status: "signed-out" }), refresh: vi.fn().mockResolvedValue(connected),
    disconnect: vi.fn().mockResolvedValue({ status: "signed-out" }),
    onState: vi.fn(callback => { push = callback; return unsubscribe; }),
  };
  vi.stubGlobal("window", { ogb: { organization: bridge } });
  vi.stubGlobal("fetch", vi.fn());
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });
async function ready(state: ManagedDesktopState = { status: "signed-out" }) {
  vi.mocked(bridge.state).mockResolvedValueOnce(state);
  render(); const cleanup = fixture.effects[0](); await flush(); return cleanup;
}

describe("optional desktop Organisation settings", () => {
  it("acknowledges only the mounted local panel without authorizing enrollment", async () => {
    render();
    expect(bridge.settingsOpened).not.toHaveBeenCalled();
    fixture.effects[0](); await flush();
    expect(bridge.settingsOpened).toHaveBeenCalledExactlyOnceWith();
    expect(bridge.begin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not acknowledge local Settings from a companion renderer", async () => {
    vi.stubGlobal("window", { ogb: { organization: bridge, remoteClient: { active: true } } });
    render(); fixture.effects[0](); await flush();
    expect(bridge.settingsOpened).not.toHaveBeenCalled();
    expect(bridge.state).not.toHaveBeenCalled();
  });

  it("keeps the panel usable if its native destination acknowledgment fails", async () => {
    vi.mocked(bridge.settingsOpened!).mockRejectedValueOnce(new Error("fixture write failure"));
    await ready();
    expect(render().html).toContain("Sign in with your organization");
    expect(bridge.begin).not.toHaveBeenCalled();
  });

  it("uses the default portal from one sign-in action and keeps custom setup advanced", async () => {
    await ready();
    let view = render();
    expect(view.html).toContain("https://admin.openmausbot.com");
    expect(view.html).toContain("Sign in with your organization");
    expect(view.html).toContain("<summary");
    expect(view.html).toContain("Advanced");
    expect(view.html).not.toMatch(/<details[^>]*\bopen/);
    expect(view.html).toContain("personal and local models");
    expect(view.html).toContain("does not upload your chat history");
    expect(bridge.begin).not.toHaveBeenCalled();
    const signIn = () => view.nodes.find(node => node.type === "button" && node.props.children === "Sign in with your organization")!.props.onClick!();
    signIn(); signIn(); await flush();
    expect(bridge.begin).toHaveBeenCalledExactlyOnceWith({ portalOrigin: "https://admin.openmausbot.com" });
    expect(fetch).not.toHaveBeenCalled();
    const progress = render().html;
    expect(progress).toContain("Finish signing in through your browser");
    expect(progress).toContain("connect automatically");
    expect(progress).toMatch(/<details[^>]*><summary[^>]*>Security details<\/summary>[\s\S]*ABCDE-FGHIJ[\s\S]*<\/details>/);
    expect(progress).not.toContain("admin.example.test/enroll");
    expect(progress).not.toMatch(/<details[^>]*\bopen/);
    button("Cancel sign-in").props.onClick!(); await flush();
    expect(bridge.cancelEnrollment).toHaveBeenCalledOnce(); view = render();
    view.nodes.find(node => node.type === "input")!.props.onChange!({ target: { value: " https://admin.example.test " } });
    view = render();
    view.nodes.find(node => node.type === "form")!.props.onSubmit!({ preventDefault: vi.fn() }); await flush();
    expect(bridge.begin).toHaveBeenNthCalledWith(2, { portalOrigin: "https://admin.example.test" });
  });

  it("shows company model counts, refreshes, and requires a separate disconnect confirmation", async () => {
    await ready(connected);
    const html = render().html;
    expect(html).toContain("Fixture Company"); expect(html).toContain("employee@example.test");
    expect(html).toContain("Approved models: 2"); expect(html).toContain("Not configured");
    button("Refresh").props.onClick!(); await flush(); expect(bridge.refresh).toHaveBeenCalledOnce();
    button("Disconnect…").props.onClick!();
    expect(bridge.disconnect).not.toHaveBeenCalled();
    expect(render().html).toContain("stops running Company turns");
    expect(render().html).toContain("will not switch to personal billing");
    button("Keep connection").props.onClick!(); expect(bridge.disconnect).not.toHaveBeenCalled();
    button("Disconnect…").props.onClick!();
    button("Disconnect from organization").props.onClick!(); await flush();
    expect(bridge.disconnect).toHaveBeenCalledOnce();
    expect(render().html).toContain("Sign in with your organization");
  });

  it("requires disconnect before reconnecting revoked access and does not promise cloud backups", async () => {
    await ready({ ...connected, status: "reauth-required", cloudBackups: true });
    const html = render().html;
    expect(html).toContain("Disconnect below, then sign in again");
    expect(html).not.toContain("Sign in with your organization");
    expect(html).not.toContain("Approved models:");
    expect(html).not.toContain("backup");
    expect(button("Refresh")).toBeUndefined();
    button("Disconnect…").props.onClick!(); button("Disconnect from organization").props.onClick!(); await flush();
    expect(render().html).toContain("Sign in with your organization");
  });

  it("reopens only the pending sign-in page, with nothing supplied by the panel", async () => {
    await ready(connecting);
    const reopen = () => button("Open the sign-in page again");
    reopen().props.onClick!(); reopen().props.onClick!(); await flush();
    expect(bridge.reopen).toHaveBeenCalledOnce();
    expect(bridge.reopen).toHaveBeenCalledWith();
    expect(bridge.begin).not.toHaveBeenCalled();
    expect(render().html).toContain("Finish signing in through your browser");
    delete bridge.reopen;
    expect(reopen()).toBeUndefined();
    expect(button("Cancel sign-in")).toBeDefined();
  });

  it("switches only bots that cannot run, and disconnecting leaves personal selections untouched", async () => {
    const managed = { organizationId: "fixture-org", organizationName: "Fixture Company" };
    fixture.store.instances = [
      { instanceId: "personal", driverKind: "codex", displayName: "Codex", snapshot: { state: "available", authenticated: true }, models: { default: "gpt", options: [] } },
      { instanceId: "company.fixture.anthropic", driverKind: "claudeAgent", displayName: "Company · Fixture Company · Claude", readOnly: true, managed,
        snapshot: { state: "available", authenticated: true }, models: { default: "model-a", options: [] } },
    ];
    const bot = (id: string, instanceId: string) => ({ id, threadId: `${id}-thread`, name: id, modelSelection: { instanceId, model: "saved" } });
    fixture.store.bots = [bot("personal-bot", "personal"), bot("stuck-bot", "missing")];
    await ready(connected);
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
    button("Use Company · Fixture Company · Claude for 1 bot that can’t run").props.onClick!(); await flush();
    expect(fixture.store.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: "stuck-bot", selection: { instanceId: "company.fixture.anthropic", model: "model-a" } });
    button("Disconnect…").props.onClick!(); button("Disconnect from organization").props.onClick!(); await flush();
    expect(bridge.disconnect).toHaveBeenCalledOnce();
    // Disconnecting changes no bot: the only model change is the one clicked above.
    expect(fixture.store.dispatch).toHaveBeenCalledOnce();
    expect(fixture.store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ botId: "personal-bot" }));
  });

  it("explains a lapsed Admin licence without a sign-in loop and shows Company models unavailable", async () => {
    await ready({ ...connected, status: "license-expired" });
    const html = render().html;
    expect(html).toContain("Your organization&#x27;s OpenMaus Admin license has expired. Contact your admin.");
    expect(html).not.toContain("Disconnect below, then sign in again");
    expect(html).not.toContain("Sign in with your organization");
    expect(html).toContain("Unavailable until the licence is renewed");
    expect(html).not.toContain("Approved models:");
    expect(button("Refresh")).toBeDefined(); expect(button("Disconnect…")).toBeDefined();
  });

  it("says so when a sign-in finds the Admin licence expired", async () => {
    await ready({ status: "signed-out", notice: "license-expired" });
    const html = render().html;
    expect(html).toContain("license has expired. Contact your admin.");
    expect(html).toContain("Sign in with your organization");
  });

  it("keeps newer broadcast state when an initial snapshot or action resolves late", async () => {
    let resolveInitial!: (state: ManagedDesktopState) => void;
    vi.mocked(bridge.state).mockImplementation(() => new Promise(resolve => { resolveInitial = resolve; }));
    render(); fixture.effects[0]();
    push(connected); resolveInitial({ status: "signed-out" }); await flush();
    expect(render().html).toContain("Fixture Company");
    let resolveRefresh!: (state: ManagedDesktopState) => void;
    vi.mocked(bridge.refresh).mockImplementation(() => new Promise(resolve => { resolveRefresh = resolve; }));
    button("Refresh").props.onClick!();
    push({ ...connected, status: "reauth-required" }); resolveRefresh(connected); await flush();
    expect(render().html).toContain("Disconnect below, then sign in again");
  });

  it("unsubscribes and ignores late results after the panel closes", async () => {
    const cleanup = await ready();
    let resolveBegin!: (state: ManagedDesktopState) => void;
    vi.mocked(bridge.begin).mockImplementation(() => new Promise(resolve => { resolveBegin = resolve; }));
    button("Sign in with your organization").props.onClick!();
    if (typeof cleanup === "function") cleanup();
    push(connected); resolveBegin(connecting); await flush();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(render().html).not.toContain("Fixture Company");
    expect(render().html).not.toContain("ABCDE-FGHIJ");
  });

  it("shows safe errors and a usable empty-model state with English fallback", async () => {
    setLocale("ja");
    await ready({ ...connected, providers: [] });
    expect(render().html).toContain("No company models are available yet");
    vi.mocked(bridge.refresh).mockRejectedValueOnce(new Error("Private /path token-secret"));
    button("Refresh").props.onClick!(); await flush();
    expect(render().html).toContain("Could not complete this action");
    expect(render().html).not.toContain("token-secret");
    expect(render().html).not.toContain("organization.noModels");
  });

  it("keeps an action error across same-status heartbeats and clears it after a real status change", async () => {
    await ready(connected);
    vi.mocked(bridge.refresh).mockRejectedValueOnce(new Error("Fixture refresh failure"));
    button("Refresh").props.onClick!(); await flush();
    expect(render().html).toContain("Could not complete this action");

    expect(() => push({ ...connected, providers: [] })).not.toThrow();
    expect(render().html).toContain("Could not complete this action");

    expect(() => push({ ...connected, status: "reauth-required" })).not.toThrow();
    expect(render().html).not.toContain("Could not complete this action");
    expect(render().html).toContain("Disconnect below, then sign in again");
  });

  it("can clear an unavailable saved connection instead of trapping the user behind retry", async () => {
    await ready({ ...connected, status: "unavailable" });
    expect(render().html).not.toContain("Approved models:");
    expect(button("Refresh")).toBeDefined();
    button("Disconnect…").props.onClick!(); button("Disconnect from organization").props.onClick!(); await flush();
    expect(bridge.disconnect).toHaveBeenCalledOnce();
    expect(render().html).toContain("Sign in with your organization");
  });

  it.each([{}, { ogb: { remoteClient: { active: true } } }])("has no sign-in controls without the local desktop bridge", (windowState) => {
    vi.stubGlobal("window", windowState);
    expect(render().html).toContain("desktop app on this computer");
    expect(render().html).not.toContain("Sign in with your organization");
    expect(bridge.state).not.toHaveBeenCalled();
  });
});
