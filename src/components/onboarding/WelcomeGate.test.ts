import { createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, WELCOME_VERSION, type WelcomeViewer } from "@/lib/onboarding";
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
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: store.state, dispatch: store.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false }));
// The gate's job is choosing; the flow itself has its own recipe.
vi.mock("./WelcomeFlow", () => ({ WelcomeFlow: () => null }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
import { SharedWorkspaceHint } from "./SharedWorkspaceHint";
import { useWelcomeViewer, WelcomeGate } from "./WelcomeGate";
import { WelcomeFlow } from "./WelcomeFlow";

type Node = ReactElement<Record<string, unknown> & { onClick?: () => void; onClose?: () => void; onOpenOrganisation?: () => void; children?: ReactNode }>;
function render(component: () => ReactNode) {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = component();
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, tree: tree as Node | null };
}
const gate = (viewer: WelcomeViewer | null) => render(() => WelcomeGate({ viewer }));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const fresh = { onboarding: EMPTY_ONBOARDING };
// The desktop app's own page: the full bridge, remoteClient included.
const LOCAL_PAGE = { ogb: { platform: "darwin", remoteClient: { active: false }, workspaces: {} } };
// A hosted workspace the desktop app opened (Server → Connect hosted
// workspace…): preload exposes only its remote-safe subset, still truthy.
const REMOTE_PAGE = { ogb: { platform: "darwin", workspaces: {}, getCapabilities: () => ({}) } };
beforeEach(() => {
  fixture.values = [];
  fixture.index = 0;
  fixture.effects = [];
  store.dispatch.mockReset();
  store.api.mockReset();
  store.state = { config: fresh, welcomeOpen: false, appSettingsOpen: false, appSettingsSection: "general", bots: [] };
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("fetch", vi.fn());
  setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("who gets the welcome flow", () => {
  it("opens the desktop flow for the desktop app's own window, exactly as before", () => {
    vi.stubGlobal("window", LOCAL_PAGE);
    const { tree } = gate(LOCAL_VIEWER);
    expect(tree?.type).toBe(WelcomeFlow);
    expect(tree?.props).toMatchObject({ hosted: false, initialBeat: undefined, replay: false });
  });

  it("opens the hosted beat set for a hosted workspace's admin", () => {
    const { tree } = gate({ hosted: true, canSave: true });
    expect(tree?.type).toBe(WelcomeFlow);
    expect(tree?.props.hosted).toBe(true);
  });

  it("gives a hosted member a note instead, and nothing that writes the workspace config", async () => {
    const { tree, html } = gate({ hosted: true, canSave: false });
    expect(tree?.type).toBe(SharedWorkspaceHint);
    expect(html).toContain("Your team&#x27;s shared OpenMausBot");
    expect(html).not.toContain("role=\"dialog\"");
    fixture.values = [];
    const hint = render(() => SharedWorkspaceHint({ replay: false, onClose: vi.fn() }));
    const gotIt = (hint.tree!.props.children as Node[]).flatMap(function all(node): Node[] {
      if (!isValidElement(node)) return [];
      const children = (node as Node).props.children;
      return [node as Node, ...(Array.isArray(children) ? children : [children]).flatMap(all)];
    }).find((node) => node.type === "button")!;
    gotIt.props.onClick!();
    await flush();
    expect(store.api).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem("omb.onboarding.sharedWorkspaceHint")).toBe("1");
    // once dismissed, a fresh visit in this browser does not show it again
    fixture.values = [];
    expect(render(() => SharedWorkspaceHint({ replay: false, onClose: vi.fn() })).html).toBe("");
    // but Settings → Replay welcome tour shows it again
    fixture.values = [];
    expect(render(() => SharedWorkspaceHint({ replay: true, onClose: vi.fn() })).html).toContain("shared OpenMausBot");
    // storage that throws (private window) still shows it and never breaks
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    fixture.values = [];
    expect(render(() => SharedWorkspaceHint({ replay: false, onClose: vi.fn() })).html).toContain("shared OpenMausBot");
  });

  it("never opens the flow for a hosted member, even when the admin has not finished it", () => {
    store.state = { ...store.state, config: {} };
    expect(gate({ hosted: true, canSave: false }).tree?.type).toBe(SharedWorkspaceHint);
    store.state = { ...store.state, welcomeOpen: true };
    const replay = gate({ hosted: true, canSave: false }).tree!;
    expect(replay.type).toBe(SharedWorkspaceHint);
    expect(replay.props.replay).toBe(true);
    replay.props.onClose!();
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleWelcome", open: false });
  });

  it("adds nothing for a member of a server that is not hosted, such as the owner's own paired browser", () => {
    // no note: the team copy would be false there, and it would be new UI
    const { tree, html } = gate({ hosted: false, canSave: false });
    expect(tree).toBeNull();
    expect(html).toBe("");
    // an explicit Settings replay still opens the ordinary flow, as before
    store.state = { ...store.state, welcomeOpen: true };
    const replay = gate({ hosted: false, canSave: false }).tree!;
    expect(replay.type).toBe(WelcomeFlow);
    expect(replay.props).toMatchObject({ hosted: false, replay: true });
  });

  it("treats a hosted workspace opened inside the desktop app like a browser", () => {
    vi.stubGlobal("window", REMOTE_PAGE);
    expect(gate({ hosted: true, canSave: false }).tree?.type).toBe(SharedWorkspaceHint);
    const admin = gate({ hosted: true, canSave: true }).tree!;
    expect(admin.type).toBe(WelcomeFlow);
    expect(admin.props.hosted).toBe(true);
  });

  it("shows nothing to a remote client member or while a browser's session is unknown", () => {
    expect(gate(null).tree).toBeNull();
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    expect(gate({ hosted: true, canSave: false }).tree).toBeNull();
    expect(gate(LOCAL_VIEWER).tree).toBeNull();
  });

  it("stays closed after the admin finished it", () => {
    store.state = { ...store.state, config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-23T00:00:00.000Z", version: WELCOME_VERSION } } };
    expect(gate({ hosted: true, canSave: true }).tree).toBeNull();
    expect(gate(LOCAL_VIEWER).tree).toBeNull();
  });

  it("resumes on the engines beat after the organisation row opens Settings", () => {
    vi.stubGlobal("window", LOCAL_PAGE);
    const first = gate(LOCAL_VIEWER).tree!;
    first.props.onOpenOrganisation!();
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "organization" });
    store.state = { ...store.state, appSettingsOpen: true, appSettingsSection: "organization" };
    expect(gate(LOCAL_VIEWER).tree).toBeNull();
    store.state = { ...store.state, appSettingsOpen: false };
    const resumed = gate(LOCAL_VIEWER).tree!;
    expect(resumed.props.initialBeat).toBe("engines");
    // finishing forgets it: a later Settings replay starts at the greeting
    (resumed.props.onDone as () => void)();
    store.state = { ...store.state, welcomeOpen: true };
    expect(gate(LOCAL_VIEWER).tree?.props.initialBeat).toBeUndefined();
  });
});

describe("useWelcomeViewer", () => {
  const viewer = () => {
    let value: WelcomeViewer | null = null;
    render(() => {
      value = useWelcomeViewer();
      return null;
    });
    return value;
  };

  it("knows the desktop app's own window without asking", () => {
    vi.stubGlobal("window", LOCAL_PAGE);
    expect(viewer()).toEqual(LOCAL_VIEWER);
    for (const effect of fixture.effects) effect();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("asks the server from a hosted page the desktop app opened, whose bridge is reduced", async () => {
    vi.stubGlobal("window", REMOTE_PAGE);
    store.api.mockResolvedValueOnce({ kind: "session", scopes: ["client"], hosted: true });
    expect(viewer()).toBeNull();
    for (const effect of fixture.effects) effect();
    await flush();
    expect(store.api).toHaveBeenCalledExactlyOnceWith("/api/auth/session", { timeoutMs: 10_000 });
    expect(viewer()).toEqual({ hosted: true, canSave: false });
  });

  it("asks a browser's server once and reads hosted and scope from the answer", async () => {
    store.api.mockResolvedValueOnce({ kind: "session", scopes: ["client"], hosted: true });
    expect(viewer()).toBeNull();
    for (const effect of fixture.effects) effect();
    await flush();
    expect(store.api).toHaveBeenCalledExactlyOnceWith("/api/auth/session", { timeoutMs: 10_000 });
    expect(viewer()).toEqual({ hosted: true, canSave: false });
  });

  it("keeps today's behaviour when the answer does not come", async () => {
    store.api.mockRejectedValueOnce(new Error("offline"));
    viewer();
    for (const effect of fixture.effects) effect();
    await flush();
    expect(viewer()).toEqual(LOCAL_VIEWER);
  });
});
