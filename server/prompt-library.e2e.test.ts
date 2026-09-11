// The prompt-library route, end to end against an isolated fixture server:
// the catalog answers with the original built-ins, and a bad import source
// is a typed error, not a crash. Import from real GitHub is covered by the
// unit tests' fake fetch; this file proves the HTTP surface itself.
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

it("serves the built-in prompt catalog and rejects bad import sources", async () => {
  const fixture = await launchVerificationServer();
  const url = fixture.info.url;
  try {
    const catalog = await request("/api/prompt-library", {}, url);
    expect(catalog.presets.length).toBeGreaterThanOrEqual(6);
    for (const preset of catalog.presets) {
      expect(preset.id).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.source).toBe("built-in");
      expect(Buffer.byteLength(preset.text, "utf8")).toBeLessThanOrEqual(24_000);
    }
    expect(catalog.presets.map((p: { id: string }) => p.id)).toEqual(
      [...new Set(catalog.presets.map((p: { id: string }) => p.id))],
    );
    expect(catalog.collections.length).toBeGreaterThanOrEqual(8);
    for (const collection of catalog.collections) {
      expect(collection.label).toBeTruthy();
      expect(collection.source).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\//);
    }
    await expect(request("/api/prompt-library/not%20a%20github%20url", {}, url)).rejects.toThrow();
  } finally {
    await fixture.close();
  }
}, 90_000);
