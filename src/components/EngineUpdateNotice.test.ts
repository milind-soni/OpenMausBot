import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineUpdateNotice } from "./EngineSetup";

const update = {
  title: "Update Codex for GPT-6 Astra",
  message: "This Codex version predates Astra support. Update it, then refresh models.",
  command: "codex update",
};

afterEach(() => vi.unstubAllGlobals());

describe("EngineUpdateNotice", () => {
  it("keeps the terminal command visible and copyable without blocking the model list", () => {
    const markup = renderToStaticMarkup(createElement(EngineUpdateNotice, { update }));

    expect(markup).toContain("data-engine-update-notice");
    expect(markup).toContain("Update Codex for GPT-6 Astra");
    expect(markup).toContain("codex update");
    expect(markup).toContain('aria-label="Copy command"');
  });

  it("shows only the note when there is nothing to run, as on My Cloud", () => {
    const cloud = { title: "Codex 0.160.1 is out", message: "On My Cloud, Codex updates with the Cloud." };
    const markup = renderToStaticMarkup(createElement(EngineUpdateNotice, { update: cloud }));

    expect(markup).toContain("On My Cloud, Codex updates with the Cloud.");
    expect(markup).not.toContain('aria-label="Copy command"');
    expect(markup).not.toContain("<button");
  });

  it("offers the native Terminal action when the desktop bridge supports it", () => {
    vi.stubGlobal("window", { ogb: { openInstallTerminal: vi.fn() } });

    const markup = renderToStaticMarkup(createElement(EngineUpdateNotice, { update }));

    expect(markup).toContain('aria-label="Open update in Terminal"');
    expect(markup).toContain("Terminal");
  });
});
