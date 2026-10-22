import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { tellDesktopLanguage } from "@/lib/desktop-language";
import { setLocale } from "@/lib/i18n";

afterEach(() => setLocale("en"));

const bridge = (set = vi.fn(async (_code: string) => {})) => ({ set });

it("tells main nothing while the server's default language is still unknown", () => {
  const desktop = bridge();
  expect(tellDesktopLanguage("", false, desktop)).toBeUndefined();
  expect(desktop.set).not.toHaveBeenCalled();
});

it("once the server's config is in, no language means the system's", async () => {
  const desktop = bridge();
  await tellDesktopLanguage("", true, desktop);
  expect(desktop.set).toHaveBeenCalledWith("");
});

it("an explicit language reaches main as its pack's code, before or after the config", async () => {
  for (const configLoaded of [false, true]) {
    const desktop = bridge();
    setLocale("pt");
    await tellDesktopLanguage("pt", configLoaded, desktop);
    expect(desktop.set).toHaveBeenCalledWith("pt-br");
  }
  const desktop = bridge();
  setLocale("zh-HK");
  await tellDesktopLanguage("zh-HK", true, desktop);
  expect(desktop.set).toHaveBeenCalledWith("zh-tw");
});

it("a refused call from main never surfaces in the page, and no bridge is no call", async () => {
  const desktop = bridge(vi.fn(async () => { throw new Error("desktop-language:set is only available in this app's window"); }));
  await expect(tellDesktopLanguage("", true, desktop)).resolves.toBeUndefined();
  expect(tellDesktopLanguage("pt-br", true, undefined)).toBeUndefined();
});

it("the app tells main each time the language or the config's arrival changes", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  expect(app).toMatch(/const configLoaded = state\.config !== null;\n\s*useEffect\(\(\) => \{ void tellDesktopLanguage\(language, configLoaded\); \}, \[language, configLoaded\]\);/);
});
