import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDesktopBridge } from "../../../../electron/managed-desktop.mjs";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

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
const store = vi.hoisted(() => ({ instances: [] as unknown[], dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: { instances: store.instances }, dispatch: store.dispatch }) }));
// The row has its own tests; here only whether the beat offers it.
vi.mock("./OrganisationRow", () => ({ OrganisationRow: () => null }));
import { EnginesBeat } from "./EnginesBeat";
import { OrganisationRow } from "./OrganisationRow";

type Node = ReactElement<{ children?: ReactNode; bridge?: unknown; onOpenSettings?: () => void; onConnected?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return Children.toArray(value as ReactNode).flatMap((child) => (isValidElement(child) ? nodes(child) : []));
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

const personal = (instanceId: string, ready: boolean): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready },
  models: { default: "m", options: [] },
});
const company = (ready: boolean): InstanceInfo => ({
  instanceId: "company.fixture.anthropic", driverKind: "claudeAgent", displayName: "Company · Fixture · Claude", readOnly: true,
  managed: { organizationId: "fixture-org", organizationName: "Fixture" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready },
  models: { default: "m", options: [] },
});
const bridge = { onState: vi.fn(), state: vi.fn() } as unknown as ManagedDesktopBridge;
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };

function render(extra: { hosted?: boolean; onOpenOrganisation?: () => void } = {}) {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = EnginesBeat({ ...props, ...extra });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, row: nodes(tree).find((node) => node.type === OrganisationRow) };
}

beforeEach(() => {
  fixture.values = [];
  store.dispatch.mockReset();
  store.instances = [personal("claude", false), personal("codex", false)];
  vi.stubGlobal("window", {});
  setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("organisation sign-in in the engines beat", () => {
  it("is absent without the desktop bridge, and the counts are unchanged", () => {
    const { html, row } = render();
    expect(row).toBeUndefined();
    expect(html).toContain("0 ready");
    expect(html).toContain("2 to set up");
    expect(html).not.toContain("Everything is ready");
  });

  it("is absent on a remote client and on a hosted workspace", () => {
    vi.stubGlobal("window", { ogb: { organization: bridge, remoteClient: { active: true } } });
    expect(render().row).toBeUndefined();
    vi.stubGlobal("window", { ogb: { organization: bridge } });
    expect(render({ hosted: true }).row).toBeUndefined();
  });

  it("is the first row on the local desktop and opens Settings → Organisation for other addresses", () => {
    vi.stubGlobal("window", { ogb: { organization: bridge } });
    const { html, row } = render();
    expect(row?.props.bridge).toBe(bridge);
    expect(html).toContain("2 to set up");
    row!.props.onOpenSettings!();
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "organization" });
    const resume = vi.fn();
    render({ onOpenOrganisation: resume }).row!.props.onOpenSettings!();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("reads everything as ready when a signed-in Company engine is all there is", () => {
    vi.stubGlobal("window", { ogb: { organization: bridge } });
    store.instances = [personal("claude", false), personal("codex", false), company(true)];
    const html = render().html;
    expect(html).toContain("Everything is ready");
    expect(html).not.toContain("to set up");
    // personal engines stay listed, below, as optional
    expect(html).toContain("The engines below are your own, and optional.");
    expect(html).toContain("claude");
    expect(html).toContain("codex");
    // the guide reacts as it does when everything personal is ready
    store.api.mockResolvedValue({ instances: store.instances });
    props.setMascot.mockClear();
    for (const effect of fixture.effects) effect();
    expect(props.setMascot).toHaveBeenLastCalledWith("proud");
  });

  it("does not count a Company engine that cannot run yet", () => {
    vi.stubGlobal("window", { ogb: { organization: bridge } });
    store.instances = [personal("claude", false), company(false)];
    const html = render().html;
    expect(html).toContain("1 to set up");
    expect(html).not.toContain("Everything is ready");
  });
});
