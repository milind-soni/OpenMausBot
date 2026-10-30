import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./GrokImportFlow", () => ({ GrokImportFlow: (props: { bare?: boolean }) => `GROK_FLOW(bare=${String(props.bare)})` }));

import { StoreContext } from "@/state/store";
import type { SetupDetection } from "../../shared/setup-import";
import { AiAppsImportView, ImportSettings, type AiAppsImportViewProps } from "./ImportSettings";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const FOUND: SetupDetection = {
  skills: [{ name: "pdf", source: "claudeCode" }, { name: "review", source: "codex" }],
  tools: [{ name: "notion", source: "cursor" }],
};
const apps = (overrides: Partial<AiAppsImportViewProps> = {}) => text(renderToStaticMarkup(createElement(AiAppsImportView, {
  local: true, detection: FOUND, chosen: { skills: true, tools: true }, status: "idle", result: null, onChoose: vi.fn(), onBring: vi.fn(), ...overrides,
})));

describe("Settings → Import", () => {
  it("draws From your AI apps and From Grok Bot", () => {
    const value = { state: { config: {} }, dispatch: vi.fn() } as never;
    const markup = renderToStaticMarkup(createElement(StoreContext.Provider, { value }, createElement(ImportSettings, {
      client: { detect: vi.fn(() => new Promise<SetupDetection>(() => {})), apply: vi.fn() },
    })));
    expect(markup).toContain('data-import-section="apps"');
    expect(markup).toContain('data-import-section="grok"');
    const shown = text(markup);
    expect(shown).toContain("From your AI apps");
    expect(shown).toContain("Claude Code, Codex, Cursor, Claude Desktop and Gemini");
    expect(shown).toContain("Tools arrive switched off; logins and history are never read.");
    expect(shown).toContain("From Grok Bot");
    expect(shown).toContain("GROK_FLOW(bare=true)");
    expect(markup.indexOf('data-import-section="apps"')).toBeLessThan(markup.indexOf('data-import-section="grok"'));
  });

  it("offers the welcome step's rows, with its counts, sources and switched-off note", () => {
    const shown = apps();
    expect(shown).toContain("2 from Claude Code and Codex");
    expect(shown).toContain("1 MCP server from Cursor");
    expect(shown).toContain("Added switched off.");
    expect(shown).toContain("Bring them in");
  });

  it("says what happened: looking, nothing new, not this computer, or the result", () => {
    expect(apps({ detection: undefined })).toContain("Looking on this computer…");
    expect(apps({ detection: { skills: [], tools: [] } })).toContain("Nothing new to bring in from your AI apps.");
    expect(apps({ local: false })).toContain("Only the desktop app on the computer running MausBot");
    expect(apps({ result: { skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] } } })).toContain("Added 1 skill.");
  });

  it("uses the one shared bot import in Templates and Settings", () => {
    const source = (file: string) => readFileSync(join(import.meta.dirname, file), "utf8");
    for (const file of ["TeamLibraryPanel.tsx", "ImportSettings.tsx"]) {
      expect(source(file), file).toMatch(/import \{ GrokImportFlow \} from "(?:\.\/|@\/components\/)GrokImportFlow"/);
      expect(source(file), file).toContain("<GrokImportFlow");
      expect(source(file), file).not.toContain("<GrokImportBox");
    }
  });
});
