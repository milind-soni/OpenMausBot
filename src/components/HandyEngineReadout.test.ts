// The readout is the one place that tells the user which model their dictation
// will actually run, so each status shape is pinned here: what Handy selected,
// what is on this computer, what this machine can carry, and what a pin can
// legally be. It is driven by props precisely so these cases need no bridge, no
// microphone and no Electron process.
//
// What this file does not cover: the interaction. Static markup cannot fire an
// onChange, so the one line that persists a pin (SettingsModal's onPin) is
// covered only by type-checking here.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import {
  HandyEngineReadout,
  type HandyReadoutCatalogEntry,
  type HandyReadoutStatus,
} from "./HandyEngineReadout";

const CANARY = "handy-computer/canary-180m-flash-gguf/canary-180m-flash-Q8_0.gguf";
const PARAKEET_V2 = "parakeet-tdt-0.6b-v2";
const PARAKEET_V3 = "parakeet-tdt-0.6b-v3";

const canary: HandyReadoutCatalogEntry = { id: CANARY, name: "Canary 180M Flash", sizeMB: 208, downloaded: true };
const parakeetV2: HandyReadoutCatalogEntry = { id: PARAKEET_V2, name: "Parakeet V2", sizeMB: 451, downloaded: true };
const parakeetV3: HandyReadoutCatalogEntry = { id: PARAKEET_V3, name: "Parakeet V3", sizeMB: 456, downloaded: false };

const status = (overrides: Partial<HandyReadoutStatus> = {}): HandyReadoutStatus => ({
  found: true,
  selected: CANARY,
  // Folder names: what the disk holds, including a custom model the catalog
  // does not know about.
  installed: ["parakeet-tdt-0.6b-v2-int8", "some-custom-model"],
  catalog: [canary, parakeetV2, parakeetV3],
  device: { cores: 8, ramGB: 8 },
  ...overrides,
});

const render = (overrides: Partial<HandyReadoutStatus> = {}, pinned = "") =>
  renderToStaticMarkup(
    createElement(HandyEngineReadout, { status: status(overrides), pinned, onPin: vi.fn() }),
  );

beforeEach(() => setLocale("en"));

describe("Handy engine readout", () => {
  it("names Handy's selected model instead of showing its id", () => {
    const html = render();
    expect(html).toContain("Dictation engine");
    expect(html).toContain("Canary 180M Flash</span>");
  });

  it("lists what is on this computer by catalog name when the catalog is known", () => {
    const html = render();
    expect(html).toContain("Models on this computer: Canary 180M Flash, Parakeet V2");
    expect(html).not.toContain("parakeet-tdt-0.6b-v2-int8");
  });

  it("falls back to the folder names when Handy's catalog cannot be read", () => {
    const html = render({ catalog: [] });
    expect(html).toContain("parakeet-tdt-0.6b-v2-int8, some-custom-model");
  });

  it("says a model was never downloaded rather than leaving a blank", () => {
    const html = render({ catalog: [], selected: null, installed: [] });
    expect(html).toContain("none yet");
    expect(html).toContain("unknown");
  });

  it("says Handy is not at the configured path instead of showing a stale model", () => {
    // The shell skips the catalog call when there is no executable, so this is
    // the real shape of that status, not a convenient one.
    const html = render({ found: false, catalog: [] });
    expect(html).toContain("Handy isn&#x27;t at this path");
    expect(html).not.toContain("Handy&#x27;s model");
  });

  it("offers only models Handy has downloaded, because the others cannot run", () => {
    const html = render();
    // Follow, Canary, Parakeet V2 — and deliberately not Parakeet V3, which
    // Handy refuses with "Model not downloaded".
    expect(html.match(/<option/g)?.length).toBe(3);
    expect(html).not.toContain(`value="${PARAKEET_V3}"`);
    expect(html).toContain('<option value="" selected="">Whatever Handy has selected</option>');
    expect(html).toContain("Parakeet V2 (451 MB)");
  });

  it("keeps a pin that is no longer downloaded visible, and warns it will fail", () => {
    const html = render({}, PARAKEET_V3);
    expect(html).toContain(`<option value="${PARAKEET_V3}" selected="">Parakeet V3 — not downloaded</option>`);
    expect(html).toContain("Pinned to Parakeet V3, which Handy has not downloaded");
  });

  it("does not accuse a pin it cannot judge, when the catalog is unreadable", () => {
    const html = render({ catalog: [] }, "some-custom-model");
    expect(html).toContain('<option value="some-custom-model" selected="">some-custom-model</option>');
    expect(html).not.toContain("has not downloaded");
  });

  it("advises the model this machine can carry and admits it is already installed", () => {
    const html = render();
    expect(html).toContain("This computer (8 cores, 8 GB) is best served by Parakeet V2/V3 (int8).");
    expect(html).toContain("Already installed");
  });

  it("marks advice this machine does not have yet", () => {
    const html = render({ catalog: [parakeetV3], installed: [] });
    expect(html).toContain("Not installed yet");
    expect(html).not.toContain("Already installed");
  });

  it("sends a big machine to a large Whisper tier", () => {
    expect(render({ device: { cores: 16, ramGB: 32 } })).toContain("Whisper Large");
  });
});
