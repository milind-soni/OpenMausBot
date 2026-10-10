// The picker that switches the language sits inside this screen, so the screen
// has to answer to it while it is open. The trap is module scope: SECTIONS is
// built once at import time, and a label resolved there would keep the language
// the app booted in no matter what the picker says.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { en, locales } from "@/locales";
import { StoreProvider } from "@/state/store";

// This suite has no DOM. The screen only asks the desktop bridge whether it is
// there, so an empty window answers it the way a browser tab does.
beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {};
  // the skin picker reads the attribute main.tsx stamps before first paint
  (globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } };
});

// Analytics boots PostHog on import, which wants a real browser.
// Pinned to Advanced: these cover the Advanced rail; Simple has its own suite.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
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
    expect(pt).toContain("Provedores de modelos");
    expect(pt).toContain("Idioma do app");
    expect(pt).toContain("Duração máxima do turno");

    // same module instance, no reload: a frozen label would still say
    // "Provedores de modelos" here
    setLocale("ja");
    const ja = await renderSettings();
    expect(ja).toContain("設定");
    expect(ja).toContain("モデルプロバイダー");
    for (const key of [
      "settings.group.you", "settings.group.computers", "settings.group.account",
      "settings.section.appearance", "settings.section.backups", "settings.section.people",
      "settings.advancedMode.title",
    ] as const) {
      expect(locales.ja[key], key).toBeTruthy();
      expect(locales.ja[key], key).not.toBe(en[key]);
      expect(ja, key).toContain(locales.ja[key]!);
    }
    expect(ja).not.toContain("Provedores de modelos");
  });

  it("stays English when no language is picked", async () => {
    setLocale("en");
    const en = await renderSettings();
    expect(en).toContain("Settings");
    expect(en).toContain("Model providers");
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
