import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { ChromeRow } from "./ChromeRow";

const props: ComponentProps<typeof ChromeRow> = {
  botName: "Scout", tabs: [], nav: { url: "about:blank", loading: false, canGoBack: false, canGoForward: false },
  connected: false, control: null, takeStatus: "", commandsReady: false, closesLastTab: false, profileName: "Work", fullscreen: false, maximized: false, menu: null,
  onCommand: vi.fn(), onAddress: vi.fn(), onTake: vi.fn(), onHandBack: vi.fn(), onFullscreen: vi.fn(), onMaximize: vi.fn(), onProfiles: vi.fn(),
};

afterEach(() => setLocale("en"));

describe("browser window controls", () => {
  it.each([
    ["en", "Maximize (fill the app window)", "Full screen (whole display)", "Maximize", "Full screen"],
    ["pt-br", "Maximizar (ocupar a janela do app)", "Usar tela cheia (ocupar o monitor inteiro)", "Maximizar", "Tela cheia"],
  ])("distinguishes the app window from the whole display in %s", (locale, maximizeHint, fullscreenHint, maximize, fullscreen) => {
    setLocale(locale);
    const html = renderToStaticMarkup(createElement(ChromeRow, props));
    expect(html).toContain(`title="${maximizeHint}" aria-label="${maximize}"`);
    expect(html).toContain(`title="${fullscreenHint}" aria-label="${fullscreen}"`);
  });

  it.each([
    ["en", "Restore size", "Exit full screen"],
    ["pt-br", "Restaurar tamanho", "Sair da tela cheia"],
  ])("keeps restore and exit labels in %s", (locale, restore, exit) => {
    setLocale(locale);
    const html = renderToStaticMarkup(createElement(ChromeRow, { ...props, maximized: true, fullscreen: true }));
    expect(html).toContain(`title="${restore}" aria-label="${restore}"`);
    expect(html).toContain(`title="${exit}" aria-label="${exit}"`);
  });
});
