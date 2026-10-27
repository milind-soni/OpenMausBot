import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SetupDetection } from "../../../shared/setup-import";

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
const local = vi.hoisted(() => ({ detect: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/setup-import", async (original) => ({ ...(await original<typeof import("@/lib/setup-import")>()), setupImportApi: local }));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { instances: [] }, dispatch: vi.fn() }) }));
vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
// Each beat has its own recipe; here only which ones the flow offers.
vi.mock("./beats/HelloBeat", () => ({ HelloBeat: () => null }));
vi.mock("./beats/EnginesBeat", () => ({ EnginesBeat: () => null }));
const importBeat = vi.hoisted(() => ({ props: null as null | { onBusy?: (busy: boolean) => void; onResult: (result: unknown) => void } }));
vi.mock("./beats/ImportBeat", () => ({ ImportBeat: (props: typeof importBeat.props) => { importBeat.props = props; return null; } }));
import { WelcomeFlow } from "./WelcomeFlow";

const FOUND: SetupDetection = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [] };
const LOCAL_PAGE = { ogb: { remoteClient: { active: false } } };

function render(props: Partial<Parameters<typeof WelcomeFlow>[0]> = {}) {
  fixture.index = 0;
  fixture.effects = [];
  function Capture(): ReactNode {
    return WelcomeFlow({ onDone: () => {}, dictation: false, ...props });
  }
  return renderToStaticMarkup(createElement(Capture));
}
const settle = async (props: Partial<Parameters<typeof WelcomeFlow>[0]> = {}) => {
  render(props);
  for (const effect of fixture.effects) effect();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return render(props);
};

beforeEach(() => {
  fixture.values = [];
  local.detect.mockReset();
  vi.stubGlobal("window", LOCAL_PAGE);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the import step in the welcome flow", () => {
  it("joins after the engines when the desktop app's own server finds something new", async () => {
    local.detect.mockResolvedValue(FOUND);
    expect(render()).toContain("Step 1 of 2");
    expect(await settle()).toContain("Step 1 of 3");
    expect(local.detect).toHaveBeenCalledOnce();
  });

  it("stays out when nothing is found, the look fails, or it would land behind the person", async () => {
    local.detect.mockResolvedValue({ skills: [], tools: [] });
    expect(await settle()).toContain("Step 1 of 2");
    fixture.values = [];
    local.detect.mockRejectedValue(new Error("403"));
    expect(await settle()).toContain("Step 1 of 2");
    fixture.values = [];
    local.detect.mockResolvedValue(FOUND);
    expect(await settle({ initialBeat: "permissions", dictation: true })).toContain("Step 3 of 3");
  });

  it("never looks on a hosted server or from another server's page", async () => {
    await settle({ hosted: true });
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    fixture.values = [];
    await settle();
    vi.stubGlobal("window", { ogb: {} });
    fixture.values = [];
    await settle();
    expect(local.detect).not.toHaveBeenCalled();
  });

  it("opens straight on the step with a detection handed in, without looking", () => {
    const client = { detect: vi.fn(), apply: vi.fn() };
    const html = render({ setupImport: { client, detection: FOUND }, initialBeat: "import" });
    expect(html).toContain("Bring what you already use");
    expect(html).toContain("Step 3 of 3");
    for (const effect of fixture.effects) effect();
    expect(client.detect).not.toHaveBeenCalled();
  });

  it("holds Back while things are coming in, and keeps the first result", () => {
    const client = { detect: vi.fn(), apply: vi.fn() };
    const props = { setupImport: { client, detection: FOUND }, initialBeat: "import" as const };
    const back = (html: string) => /<button[^>]*>Back<\/button>/.exec(html)![0];
    expect(back(render(props))).not.toContain('disabled=""');
    importBeat.props!.onBusy!(true);
    expect(back(render(props))).toContain('disabled=""');
    const first = { skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] } };
    importBeat.props!.onResult(first);
    importBeat.props!.onResult({ skills: { added: [], present: ["pdf"], skipped: [], filesLeftOut: 0, review: [] } });
    importBeat.props!.onBusy!(false);
    expect(back(render(props))).not.toContain('disabled=""');
    expect((importBeat.props as unknown as { result: unknown }).result).toEqual(first);
  });
});
