// Settings → Voice & Handy. The picker is rendered from plain props so the
// list, the marked selection, and the per-voice preview are pinned here; the
// section's own wiring (the /api/tts/voices fetch, the config writes) needs a
// live renderer and is exercised in the app.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { VoicePicker } from "./VoiceHandySection";

const voices = [
  { id: "en_US-ryan-high", label: "Ryan", description: "high quality" },
  { id: "en_US-amy-medium", label: "Amy", description: "medium quality" },
];

const render = (selected: string, canPreview = true) =>
  renderToStaticMarkup(
    createElement(VoicePicker, {
      voices,
      selected,
      canPreview,
      onSelect: vi.fn(),
      onPreview: vi.fn(),
    }),
  );

describe("Voice picker", () => {
  it("marks exactly one row as the chosen voice", () => {
    const html = render("en_US-amy-medium");
    expect(html).toContain("Ryan");
    expect(html).toContain("Amy");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
  });

  it("shows each voice's own description next to its name", () => {
    const html = render("en_US-ryan-high");
    expect(html).toContain("high quality");
    expect(html).toContain("medium quality");
  });

  it("offers a preview per row, named for the voice it will speak", () => {
    const html = render("en_US-ryan-high");
    expect(html).toContain('aria-label="Hear Ryan"');
    expect(html).toContain('aria-label="Hear Amy"');
  });

  it("leaves previews disabled when the engine has nothing to speak with", () => {
    const html = render("en_US-ryan-high", false);
    // only the two preview buttons carry disabled: a row's selection stays
    // possible while a preview is not
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
