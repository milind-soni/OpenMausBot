// Settings → Voice & Handy: the nav entry and the cards the section composes.
// Static markup only — effects do not run here, so the Handy readout (which
// arrives from the shell's bridge) is absent by design, and the voice row list
// falls back to the current selection.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "voice" as AppSettingsSection,
  dispatch: vi.fn(),
  api: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: fixture.api,
  useStore: () => ({
    state: {
      appSettingsSection: fixture.section,
      config: {
        tts: {
          configured: true,
          ready: true,
          voice: "en_US-lessac-high",
          provider: "piper",
          piperAvailable: false,
          piperInstallable: true,
          piperInstalling: false,
          piperInstallError: null,
        },
        features: { wakeWord: false },
      },
    },
    dispatch: fixture.dispatch,
  }),
}));

vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "voice";
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Voice & Handy", () => {
  it("sits in the picker beside the other sections", () => {
    const html = render();
    expect(html).toContain('<option value="voice" selected="">Voice &amp; Handy</option>');
    expect(html).toContain('<option value="engines">Engines</option>');
  });

  it("offers the voice engine, the Piper install, and the current voice", () => {
    const html = render();
    expect(html).toContain("Voice engine");
    expect(html).toContain("Install Piper");
    // Piper is the configured engine here; ElevenLabs is the other choice
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("ElevenLabs");
    // the selection survives even before the voice catalog answers
    expect(html).toContain("en_US-lessac-high");
  });

  it("keeps the Handy engine and the wake word beside the voice", () => {
    const html = render();
    expect(html).toContain("Handy (offline dictation)");
    expect(html).toContain("Handy executable");
    expect(html).toContain("Wake word");
    expect(html).toContain('aria-label="Listen for “Astra”"');
  });

  it("does not leak General settings or the ElevenLabs key row into a Piper setup", () => {
    const html = render();
    expect(html).not.toContain("Maximum turn length");
    expect(html).not.toContain("ElevenLabs key");
  });
});
