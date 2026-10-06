import { describe, expect, it } from "vitest";

import { MAX_MCP_CALL_TIMEOUT_MINUTES, MIN_MCP_CALL_TIMEOUT_MINUTES, parseMcpCallTimeoutMinutes } from "./mcp-call-timeout";

describe("parseMcpCallTimeoutMinutes", () => {
  it("accepts a whole number within the bounds", () => {
    expect(parseMcpCallTimeoutMinutes("10")).toEqual({ ok: true, minutes: 10 });
    expect(parseMcpCallTimeoutMinutes(String(MIN_MCP_CALL_TIMEOUT_MINUTES))).toEqual({ ok: true, minutes: MIN_MCP_CALL_TIMEOUT_MINUTES });
    expect(parseMcpCallTimeoutMinutes(String(MAX_MCP_CALL_TIMEOUT_MINUTES))).toEqual({ ok: true, minutes: MAX_MCP_CALL_TIMEOUT_MINUTES });
  });

  it("trims surrounding whitespace", () => {
    expect(parseMcpCallTimeoutMinutes("  15  ")).toEqual({ ok: true, minutes: 15 });
  });

  it("rejects non-numeric input", () => {
    expect(parseMcpCallTimeoutMinutes("abc").ok).toBe(false);
    expect(parseMcpCallTimeoutMinutes("").ok).toBe(false);
    expect(parseMcpCallTimeoutMinutes("10.5").ok).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(parseMcpCallTimeoutMinutes("0").ok).toBe(false);
    expect(parseMcpCallTimeoutMinutes(String(MIN_MCP_CALL_TIMEOUT_MINUTES - 1)).ok).toBe(false);
    expect(parseMcpCallTimeoutMinutes(String(MAX_MCP_CALL_TIMEOUT_MINUTES + 1)).ok).toBe(false);
    expect(parseMcpCallTimeoutMinutes("1440").ok).toBe(false);
  });
});
