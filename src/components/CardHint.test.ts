// @vitest-environment happy-dom
// Simple mode's one-line hints on an approval or app card, the first time one shows; Advanced mode spotlights them.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, WELCOME_VERSION } from "@/lib/onboarding";

const f = vi.hoisted(() => ({ advanced: false, api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => f.advanced }));
const StoreContext = vi.hoisted(() => ({ current: null as null | import("react").Context<unknown> }));
vi.mock("@/state/store", async () => {
  const { createContext, useContext } = await import("react");
  StoreContext.current = createContext<unknown>(null);
  return { api: f.api, useStore: () => {
    const value = useContext(StoreContext.current!);
    if (!value) throw new Error("useStore outside provider");
    return value;
  } };
});
const { CardHint } = await import("./CardHint");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const done = { ...EMPTY_ONBOARDING, completedAt: "2026-10-27T00:00:00.000Z", version: WELCOME_VERSION };
const show = async (id: "spot.approval" | "spot.connector", hintsSeen: string[] = []) => {
  const value = { state: { config: { onboarding: { ...done, hintsSeen } } }, dispatch: f.dispatch };
  await act(async () => { root.render(createElement(StoreContext.current!.Provider, { value } as never, createElement(CardHint, { id }))); });
};

beforeEach(() => {
  setLocale("en");
  f.advanced = false;
  f.api.mockReset();
  f.api.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a card's first-time hint", () => {
  it("stays out of Advanced mode, whose spotlights explain the cards (first: a hint shows once per launch)", async () => {
    f.advanced = true;
    await show("spot.approval", []);
    expect(host.textContent).toBe("");
    expect(f.api).not.toHaveBeenCalled();
  });

  it("says one plain line on the first approval card, and marks it seen as the spotlight did", async () => {
    await show("spot.approval");
    expect(host.textContent).toBe("Bots ask before doing anything important.");
    expect(f.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT", body: expect.stringContaining("spot.approval") }));
  });

  it("says its line on the first app card, and never once seen", async () => {
    await show("spot.connector");
    expect(host.textContent).toBe("Sign in once in your browser and every bot can use it.");
    await act(async () => root.unmount());
    root = createRoot(host);
    await show("spot.connector", ["spot.connector"]);
    expect(host.textContent).toBe("");
  });

});
