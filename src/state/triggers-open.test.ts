import { describe, expect, it } from "vitest";

import { initialState, reducer } from "./store";

describe("Triggers pop-up state", () => {
  it("opens and closes, and is one pop-up at a time with Apps and Settings", () => {
    const withApps = reducer(initialState, { type: "togglePlugins", open: true });
    const triggers = reducer(withApps, { type: "toggleTriggers", open: true });
    expect(triggers.triggersOpen).toBe(true);
    expect(triggers.pluginsOpen).toBe(false);

    expect(reducer(triggers, { type: "togglePlugins", open: true }).triggersOpen).toBe(false);
    expect(reducer(triggers, { type: "toggleAppSettings", open: true }).triggersOpen).toBe(false);
    expect(reducer(triggers, { type: "toggleNewBot", open: true }).triggersOpen).toBe(false);
    expect(reducer(triggers, { type: "showRoutines" }).triggersOpen).toBe(false);
    expect(reducer(triggers, { type: "toggleTriggers" }).triggersOpen).toBe(false);
    expect(initialState.triggersOpen).toBe(false);
  });
});
