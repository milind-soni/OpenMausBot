import { describe, expect, it } from "vitest";
import { BotImportError } from "./bot-import.ts";
import { grokMovePlan, parseGrokExport } from "./grok-import.ts";
import { hermesMovePlan, parseHermesExport } from "./hermes-import.ts";
import { PACKAGE_MAX_CONNECTIONS, SEED_FILE_MAX_BYTES } from "./package-format.ts";

describe.each([
  { source: "Grok", parse: parseGrokExport, plan: grokMovePlan },
  { source: "Hermes", parse: parseHermesExport, plan: hermesMovePlan },
])("$source import data preservation", ({ parse, plan }) => {
  const build = (data: object, takenServers?: ReadonlySet<string>) => plan(parse(JSON.stringify({ bots: [{ name: "Fixture", instructions: "Write a brief.", ...data }] }))[0]!, { takenServers });

  it.each([
    { memories: ["x".repeat(SEED_FILE_MAX_BYTES)] },
    { user_facts: ["x".repeat(SEED_FILE_MAX_BYTES)] },
    { memories: ["界".repeat(100_000)] },
  ])("rejects oversized memory before creating an importable package", (data) => {
    expect(() => build(data)).toThrow(expect.objectContaining({ code: "memoryTooLarge" }));
    expect(build({ memories: ["Short memory"] }).memories).toBe(1);
  });

  it("rejects oversized archived routine notes instead of dropping them", () => {
    expect(() => build({ routines: [{ name: "On event", trigger: "other", instruction: "x".repeat(SEED_FILE_MAX_BYTES) }] }))
      .toThrow(BotImportError);
  });

  it("retains names for URL-less apps and connections beyond the package limit", () => {
    const apps = Array.from({ length: PACKAGE_MAX_CONNECTIONS + 1 }, (_, index) => ({ name: `Server ${index}`, mcp_url: `https://s${index}.example.com/mcp` }));
    const moved = build({ apps: [...apps, { name: "Gmail", mcp_url: "" }] });
    expect(moved.document.package.connections).toHaveLength(PACKAGE_MAX_CONNECTIONS);
    const notes = moved.document.package.agents[0]!.seed!.memory["memory/import-apps.md"];
    expect(notes).toContain(`- Server ${PACKAGE_MAX_CONNECTIONS}`);
    expect(notes).toContain("- Gmail");
    expect(moved.apps).toBe(PACKAGE_MAX_CONNECTIONS + 2);
  });

  it("does not ask to reconnect an existing MCP server", () => {
    const moved = build({ apps: [{ name: "Linear", mcp_url: "https://mcp.linear.app/mcp" }, { name: "Gmail" }] }, new Set(["linear"]));
    const notes = moved.document.package.agents[0]!.seed!.memory["memory/import-apps.md"];
    expect(notes).toContain("Gmail");
    expect(notes).not.toContain("Linear");
    expect(moved.apps).toBe(1);
  });
});
