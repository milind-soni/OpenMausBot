import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTourFinished } from "@/lib/guided-tour";
import { EMPTY_ONBOARDING, MET_CHIEF_HINT, WELCOME_VERSION } from "@/lib/onboarding";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], advanced: true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced }));
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
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: store.api,
  useStore: () => ({ state: store.state, dispatch: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false }));
vi.mock("./Spotlight", () => ({ Spotlight: () => null }));
import { FirstConversationTour } from "./FirstConversationTour";
import { Spotlight } from "./Spotlight";

function render(quiet: boolean) {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = FirstConversationTour({ quiet });
    return tree;
  }
  renderToStaticMarkup(createElement(Capture));
  return tree as { type?: unknown } | null;
}

beforeEach(() => {
  fixture.values = [];
  fixture.advanced = true;
  store.api.mockReset();
  vi.stubGlobal("window", {});
  const record = { ...EMPTY_ONBOARDING, completedAt: "2026-09-23T00:00:00.000Z", version: WELCOME_VERSION };
  store.state = {
    config: { onboarding: { ...record, hintsSeen: withTourFinished(record) } },
    welcomeOpen: false,
    selectedId: "bot-1",
    bots: [{ id: "bot-1", threadId: "t-1", busy: false, messages: [{ kind: "options", card: { requestId: "r", tool: "Bash", answered: false } }] }],
  };
});

describe("first-conversation spotlights", () => {
  it("explain the approval card as before", () => {
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)?.type).toBe(Spotlight);
  });

  it("let the approval tip go once the approval it explains is answered", () => {
    store.api.mockResolvedValue({});
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)?.type).toBe(Spotlight);

    const bots = store.state.bots as Array<{ busy: boolean; messages: Array<{ card: { answered: string | false } }> }>;
    bots[0].busy = true;
    bots[0].messages[0].card.answered = "allow";
    expect(render(false)).toBeNull();
    for (const effect of fixture.effects) effect();
    expect(render(false)).toBeNull();
    expect(store.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT", body: expect.stringContaining("spot.approval") }));
  });

  it("show once the welcome is done, without waiting for the app tour, which no longer starts by itself", () => {
    const record = { ...EMPTY_ONBOARDING, completedAt: "2026-10-23T00:00:00.000Z", version: WELCOME_VERSION };
    store.state = { ...store.state, config: { onboarding: record } };
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)?.type).toBe(Spotlight);
  });

  it("wait while the welcome is open or the app tour runs from Settings", () => {
    for (const busy of [{ welcomeOpen: true }, { tourOpen: true }]) {
      fixture.values = [];
      store.state = { ...store.state, welcomeOpen: false, tourOpen: false, ...busy };
      render(false);
      for (const effect of fixture.effects) effect();
      expect(render(false), JSON.stringify(busy)).toBeNull();
    }
  });

  it("stay off in Simple mode, whose cards carry a hint line instead", () => {
    fixture.advanced = false;
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)).toBeNull();
  });

  it("show in Advanced mode whichever first run the install had", () => {
    const record = { ...EMPTY_ONBOARDING, completedAt: "2026-10-27T00:00:00.000Z", version: WELCOME_VERSION, hintsSeen: [MET_CHIEF_HINT] };
    store.state = { ...store.state, config: { onboarding: { ...record, hintsSeen: [...withTourFinished(record), MET_CHIEF_HINT] } } };
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)).not.toBeNull();
  });

  it("stay away from a hosted member, who could never dismiss them for good", () => {
    render(true);
    for (const effect of fixture.effects) effect();
    expect(render(true)).toBeNull();
    expect(store.api).not.toHaveBeenCalled();
  });
});
