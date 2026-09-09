import { afterEach, describe, expect, it } from "vitest";

import { parseMcpArguments, parseMcpEnvironment } from "./McpServersPanel";
import { setLocale, t } from "@/lib/i18n";

afterEach(() => setLocale("en"));

describe("MCP server form", () => {
  it("uses one explicit argument per line", () => {
    expect(parseMcpArguments("-y\n  @scope/server  \n\n--read-only")).toEqual([
      "-y",
      "@scope/server",
      "--read-only",
    ]);
  });

  it("preserves write-only saved values without putting them back in the form", () => {
    expect(parseMcpEnvironment("TOKEN=\nMODE=read-only", ["TOKEN"])).toEqual({
      ok: true,
      env: { TOKEN: true, MODE: "read-only" },
    });
  });

  it("rejects malformed and duplicate environment names", () => {
    expect(parseMcpEnvironment("NOT A KEY=value")).toEqual({
      ok: false,
      error: { key: "mcp.env.invalidName", params: { key: "NOT A KEY" } },
    });
    expect(parseMcpEnvironment("TOKEN=one\nTOKEN=two")).toEqual({
      ok: false,
      error: { key: "mcp.env.duplicate", params: { key: "TOKEN" } },
    });
  });

  it("retains the offending input while an existing error changes language", () => {
    setLocale("de");
    const result = parseMcpEnvironment("TOKEN_WITHOUT_EQUALS");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an environment error");

    expect(t(result.error.key, result.error.params)).toContain("TOKEN_WITHOUT_EQUALS");
    setLocale("en");
    expect(t(result.error.key, result.error.params)).toBe('Use KEY=value for “TOKEN_WITHOUT_EQUALS”.');
  });
});
