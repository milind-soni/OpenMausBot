// The Boat or self-hosted VPS choice, in both its homes (the Computer panel
// and a bot's Access settings). Boat and a self-hosted VPS follow one rule
// (shared/cloud-computer.ts): an engine that can use a computer can use
// either. The Computer engine, which could run only on Boat, is gone, so
// neither backend is offered or refused on its own, and no copy sends anyone
// to Boat to get around an engine. My Cloud's cloud computers are the plan's,
// so there it is not offered at all.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import en from "@/locales/en.json";

const fixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config }, dispatch: vi.fn() }) };
});

const { CloudBackendPicker } = await import("./CloudBackendPicker");
const picker = (value: "box" | "vps" = "box") => renderToStaticMarkup(createElement(CloudBackendPicker, { value, onChange: () => {} }));

describe("CloudBackendPicker", () => {
  afterEach(() => { fixture.config = null; });

  it("offers Boat or a self-hosted VPS on a desktop or self-hosted server", () => {
    fixture.config = { cloudHome: false };
    expect(picker()).toContain("Self-hosted VPS");
  });

  it("is hidden on My Cloud", () => {
    fixture.config = { cloudHome: true };
    expect(picker()).toBe("");
  });

  it.each(["box", "vps"] as const)("offers both backends whichever is chosen (%s)", (value) => {
    const markup = picker(value);
    expect(markup).toContain("Boat");
    expect(markup).toContain("Self-hosted VPS");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toMatch(/ACP model provider/);
  });

  it("leaves no message that tells someone to switch backends for an engine", () => {
    expect(Object.keys(en)).not.toContain("computer.err.vpsEngine");
    expect(Object.values(en).filter((value) => /switch the cloud backend to Boat/i.test(value))).toEqual([]);
  });
});
