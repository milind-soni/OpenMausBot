// The picker that switches the language sits inside this screen, so the screen
// has to answer to it while it is open. The trap is module scope: SECTIONS is
// built once at import time, and a label resolved there would keep the language
// the app booted in no matter what the picker says.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { StoreProvider } from "@/state/store";

// This suite has no DOM. The screen only asks the desktop bridge whether it is
// there, so an empty window answers it the way a browser tab does.
beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {};
  // the skin picker reads the attribute main.tsx stamps before first paint
  (globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } };
});

// Analytics boots PostHog on import, which wants a real browser.
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => {},
}));

async function renderSettings(): Promise<string> {
  const { SettingsModal } = await import("./SettingsModal");
  return renderToStaticMarkup(createElement(StoreProvider, null, createElement(SettingsModal)));
}

afterEach(() => {
  setLocale("en");
});

describe("Settings → General", () => {
  it("renders in the language the picker selected, and re-renders in the next one", async () => {
    setLocale("pt-br");
    const pt = await renderSettings();
    expect(pt).toContain("Configurações");
    expect(pt).toContain("Mecanismos");
    expect(pt).toContain("Idioma do app");
    expect(pt).toContain("Duração máxima do turno");

    // same module instance, no reload: a frozen label would still say
    // "Mecanismos" here
    setLocale("ja");
    const ja = await renderSettings();
    expect(ja).toContain("設定");
    expect(ja).toContain("エンジン");
    expect(ja).not.toContain("Mecanismos");
  });

  it("stays English when no language is picked", async () => {
    setLocale("en");
    const en = await renderSettings();
    expect(en).toContain("Settings");
    expect(en).toContain("Engines");
    expect(en).toContain("Maximum turn length");
  });

  it("offers a labeled compact section picker without removing desktop navigation", async () => {
    const html = await renderSettings();
    expect(html).toMatch(/<select[^>]*aria-label="Settings"[^>]*sm:hidden/);
    expect(html).toContain('<option value="companion">Remote access</option>');
    expect(html).toMatch(/<nav[^>]*hidden[^>]*sm:flex/);
    expect(html).toContain('id="app-settings-title" class="sr-only"');
  });
});
