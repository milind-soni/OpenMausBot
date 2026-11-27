import { afterEach, describe, expect, it } from "vitest";

import { draftBody, draftFor, draftFromPaste, parseMcpArguments, parseMcpOAuthClient, rowsBody, secretRow, soleKey } from "./mcp-draft";
import { parseMcpResultBudget, withResultBudget } from "./McpResultBudgetField";
import { setLocale, t } from "@/lib/i18n";

afterEach(() => setLocale("en"));

describe("MCP server form", () => {
  it("reads the result size limit: blank is the default, 0 never trims, grouping is fine", () => {
    expect(parseMcpResultBudget("")).toEqual({ ok: true, value: undefined });
    expect(parseMcpResultBudget("  ")).toEqual({ ok: true, value: undefined });
    expect(parseMcpResultBudget("0")).toEqual({ ok: true, value: 0 });
    expect(parseMcpResultBudget("40000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("40,000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("40 000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("40.000")).toEqual({ ok: true, value: 40_000 });
    expect(parseMcpResultBudget("1.234.567")).toEqual({ ok: true, value: 1_234_567 });
    expect(parseMcpResultBudget("40_000")).toEqual({ ok: true, value: 40_000 });
    // a decimal is refused, never read as a number ten times larger
    for (const bad of ["-1", "12.5k", "lots", "3000000", "12.5", "1,5", "1.5", "40,00", "1,234.567", "40,0000", ",000"]) {
      expect(parseMcpResultBudget(bad)).toEqual({ ok: false, error: { key: "mcp.err.resultBudget" } });
    }
    expect(t("mcp.resultBudgetHint")).toContain("8,000");
  });

  it("checks the limit before the rest of the form and adds it last, only when set", () => {
    const body = { ok: true as const, body: { command: "notes-mcp" } };
    expect(withResultBudget("40,000", () => body)).toEqual({ ok: true, body: { command: "notes-mcp", resultBudget: 40_000 } });
    expect(withResultBudget("0", () => body)).toEqual({ ok: true, body: { command: "notes-mcp", resultBudget: 0 } });
    expect(withResultBudget("", () => body)).toEqual(body);
    const nameMissing = { ok: false as const, error: { key: "mcp.err.nameAndCommand" as const } };
    expect(withResultBudget("lots", () => nameMissing)).toEqual({ ok: false, error: { key: "mcp.err.resultBudget" } });
    expect(withResultBudget("40000", () => nameMissing)).toEqual(nameMissing);
  });

  it("uses one explicit argument per line", () => {
    expect(parseMcpArguments("-y\n  @scope/server  \n\n--read-only")).toEqual([
      "-y",
      "@scope/server",
      "--read-only",
    ]);
  });

  it("keeps a saved write-only value behind a blank row and never fills it back in", () => {
    const draft = draftFor({ name: "notes", command: "npx", args: ["-y", "notes-mcp"], envKeys: ["TOKEN"], enabled: true });
    expect(draft.env.map(({ name, value, saved }) => ({ name, value, saved }))).toEqual([{ name: "TOKEN", value: "", saved: true }]);
    expect(rowsBody([...draft.env, secretRow({ name: "MODE", value: "read-only" })], "env")).toEqual({ ok: true, values: { TOKEN: true, MODE: "read-only" } });
    const remote = draftFor({ name: "gate", type: "http", url: "https://mcp.example.com/route", headerKeys: ["CF-Access-Client-Id", "CF-Access-Client-Secret"], enabled: false });
    expect(draftBody({ ...remote, headers: [remote.headers[0]!, { ...remote.headers[1]!, value: "new-secret" }] }, undefined)).toEqual({
      ok: true, body: { type: "http", url: "https://mcp.example.com/route", headers: { "CF-Access-Client-Id": true, "CF-Access-Client-Secret": "new-secret" } },
    });
  });

  it("refuses a row without a name, a bad or repeated name, and a new row without a value, naming the row and never its value", () => {
    expect(rowsBody([secretRow({ name: "", value: "" })], "header")).toEqual({ ok: true, values: {} });
    expect(rowsBody([secretRow({ name: "", value: "sk-live-1" })], "header")).toEqual({ ok: false, error: { key: "mcp.err.rowName" } });
    expect(rowsBody([secretRow({ name: "Bad Header", value: "sk-live-1" })], "header")).toEqual({ ok: false, error: { key: "mcp.headers.invalidName", params: { key: "Bad Header" } } });
    expect(rowsBody([secretRow({ name: "NOT A KEY", value: "v" })], "env")).toEqual({ ok: false, error: { key: "mcp.env.invalidName", params: { key: "NOT A KEY" } } });
    expect(rowsBody([secretRow({ name: "X-A", value: "1" }), secretRow({ name: "X-A", value: "2" })], "header")).toEqual({ ok: false, error: { key: "mcp.headers.duplicate", params: { key: "X-A" } } });
    expect(rowsBody([secretRow({ name: "CF-Access-Client-Id", value: "" })], "header")).toEqual({ ok: false, error: { key: "mcp.err.missingValue", params: { name: "CF-Access-Client-Id" } } });
  });

  it("puts what was pasted for a variable back between the text around it", () => {
    const draft = draftFromPaste({ transport: "remote", name: "api", type: "http", url: "https://api.example.com/mcp", headers: [
      { name: "Authorization", value: "", gap: { kind: "variable", names: ["TOKEN"], before: "Bearer ", after: "" } },
    ] });
    const body = (value: string) => draftBody({ ...draft, headers: [{ ...draft.headers[0]!, value }] }, undefined);
    expect(body("sk-1")).toMatchObject({ ok: true, body: { headers: { Authorization: "Bearer sk-1" } } });
    expect(body("Bearer sk-1")).toMatchObject({ ok: true, body: { headers: { Authorization: "Bearer sk-1" } } });
    expect(body("")).toEqual({ ok: false, error: { key: "mcp.err.missingValue", params: { name: "Authorization" } } });
    expect(soleKey({ ...draft, headers: [{ ...draft.headers[0]!, value: "sk-1" }] })).toBe("Bearer sk-1");
    expect(draftBody({ ...draft, url: "https://<tenant>.example.com/mcp" }, undefined)).toEqual({ ok: false, error: { key: "mcp.paste.urlMissing" } });
  });

  it("sends a sign-in app only with a client id, keeping a saved secret behind a blank", () => {
    const blank = { clientId: "", clientSecret: "", scopes: "", forgetSecret: false };
    expect(parseMcpOAuthClient(blank)).toBeUndefined();
    expect(parseMcpOAuthClient({ ...blank, clientId: "  corp-app ", scopes: "offline_access, api://x/read  " })).toEqual({
      clientId: "corp-app",
      scopes: ["offline_access", "api://x/read"],
    });
    expect(parseMcpOAuthClient({ ...blank, clientId: "corp-app" }, { clientSecretConfigured: true })).toEqual({ clientId: "corp-app", clientSecret: true });
    expect(parseMcpOAuthClient({ ...blank, clientId: "corp-app", forgetSecret: true }, { clientSecretConfigured: true })).toEqual({ clientId: "corp-app" });
    expect(parseMcpOAuthClient({ ...blank, clientId: "corp-app", clientSecret: "new" }, { clientSecretConfigured: true })).toEqual({ clientId: "corp-app", clientSecret: "new" });
  });

  it("retains the offending name while an existing error changes language", () => {
    setLocale("de");
    const result = rowsBody([secretRow({ name: "TOKEN WITH SPACE", value: "v" })], "env");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an environment error");

    expect(t(result.error.key, result.error.params)).toContain("TOKEN WITH SPACE");
    setLocale("en");
    expect(t(result.error.key, result.error.params)).toBe("“TOKEN WITH SPACE” is not a valid environment variable.");
  });
});
