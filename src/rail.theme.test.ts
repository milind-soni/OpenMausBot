// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const startTheme = vi.fn();
const loadTheme = vi.fn(async () => {});

// The window's own rail is a page of its own, beside the one main gives `theme` frames to.
vi.mock("./lib/theme/runtime", () => ({ loadTheme, startTheme }));
vi.mock("./lib/skins", () => ({ applySkinChoice: vi.fn(), readSkinChoice: () => "midnight" }));
vi.mock("./lib/fonts", () => ({ applyFont: vi.fn(), readFont: () => null }));
vi.mock("./lib/new-look", () => ({ settleInterfaceMode: vi.fn() }));
vi.mock("./lib/language-preference", () => ({ loadPageLanguage: vi.fn(async () => {}) }));
vi.mock("./lib/brand", () => ({ bootstrapBrand: vi.fn(async () => {}) }));
vi.mock("./components/ChromeRail", () => ({ ChromeRail: () => null }));
vi.mock("./components/PageBoundary", () => ({ PageBoundary: () => null }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: vi.fn() }) }));

afterEach(() => {
  delete (window as { ogb?: unknown }).ogb;
  document.body.innerHTML = "";
});

it("asks for the person's theme before it renders, so the theme reaches the window's own rail", async () => {
  (window as { ogb?: unknown }).ogb = { rail: { expand: true } };
  document.body.innerHTML = '<div id="root"></div>';
  await import("./rail");
  expect(startTheme, "the remembered theme is painted before first paint, as in every other window").toHaveBeenCalledTimes(1);
  expect(loadTheme, "the rail asks the server for the worn theme, which main's frames never reach").toHaveBeenCalledTimes(1);
});
