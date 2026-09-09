// The computer surfaces hold copy in three places a naive translation misses:
// a module-scope table (the local preview's phase map), a message parked in
// React state, and a failure sentence produced by a plain helper. Each one is
// a place where the language a pack was picked in could get frozen in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { locales } from "@/locales";
import { screenPreviewFailure } from "@/lib/screen-preview";

const capabilities: DesktopCapabilities = {
  host: { platform: "linux", label: "Ubuntu", session: "x11", packaged: true },
  windowChrome: "native",
  screenPreview: { available: true, interaction: "portal-picker" },
  dictation: { available: false, engine: "none", onDevice: false },
  localComputer: { available: false, support: "supported", enabled: false, status: "disabled" },
};

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities, ready: true }),
}));

const { LocalScreenPreview } = await import("./LocalScreenPreview");
const { CloudScreenPreview } = await import("./CloudScreenPreview");

afterEach(() => {
  setLocale("en");
});

describe("computer panel translation", () => {
  it("resolves the local preview's phase copy at render, not at import", () => {
    // The module-scope map is loaded once, in English. If it held sentences
    // instead of keys, this pack switch would change nothing.
    expect(renderToStaticMarkup(createElement(LocalScreenPreview))).toContain(
      t("computer.screen.idle"),
    );

    setLocale("pt-br");
    const html = renderToStaticMarkup(createElement(LocalScreenPreview));
    expect(html).toContain(locales["pt-br"]!["computer.screen.idle"]);
    expect(html).toContain(locales["pt-br"]!["computer.screen.title"]);
    expect(html).not.toContain(locales.en["computer.screen.idle"]);
  });

  it("hands the caller a key for a failed screen request, not a sentence", () => {
    // The caller parks this in state; a sentence would outlive the language.
    const failure = screenPreviewFailure(new DOMException("cancelled", "AbortError"));
    expect(failure).toMatchObject({ ok: false, phase: "cancelled" });

    setLocale("ja");
    expect(t(failure.messageKey)).toBe(locales.ja!["computer.screen.cancelled"]);
  });

  it("translates the cloud preview in every pack", () => {
    for (const [code, pack] of Object.entries(locales)) {
      setLocale(code);
      const html = renderToStaticMarkup(createElement(CloudScreenPreview, {
        src: null,
        name: "Atlas",
        error: null,
        starting: true,
        opening: false,
        disabled: false,
        onOpen: () => {},
        onRetry: () => {},
      }));
      expect(html, code).toContain(escapeHtml(pack["computer.phase.starting"]!));
    }
  });
});

function escapeHtml(value: string): string {
  return value.replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}
