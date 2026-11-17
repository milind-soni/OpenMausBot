// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ThemeFile } from "../../../shared/theme";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.skin;
});

async function wear(theme: ThemeFile, skinChoice: string) {
  values.set("omb-skin", skinChoice);
  const runtime = await import("./runtime");
  runtime.wearTheme({ id: "repro", theme });
  return document.documentElement.dataset.skin;
}

const bothModes = { light: { canvas: "#ffffff", accent: "#d97757" }, dark: { canvas: "#121212", accent: "#d97757" } };

it("follows the person's Light or dark choice when the theme has both a light and a dark block", async () => {
  expect(await wear({ name: "Repro", skin: "system", ...bothModes }, "midnight")).toBe("midnight");
  expect(await wear({ name: "Repro", skin: "midnight", ...bothModes }, "daylight")).toBe("daylight");
  expect(await wear({ name: "Repro", canvas: "#121212", ...bothModes }, "daylight")).toBe("daylight");
});

it("still wears the theme's own skin when it has no block for the other mode", async () => {
  expect(await wear({ name: "Night", skin: "midnight", dark: bothModes.dark }, "daylight")).toBe("midnight");
  expect(await wear({ name: "Night", canvas: "#121212" }, "daylight")).toBe("midnight");
  expect(await wear({ name: "Plain", accent: "#d97757" }, "midnight")).toBe("midnight");
  expect(await wear({ name: "Spooky", skin: "halloween", ...bothModes }, "daylight")).toBe("halloween");
});
