import { describe, expect, it } from "vitest";
import { LOGIN_IMPORT_MAX_BYTES, parseLoginCsv } from "./login-import.ts";

describe("browser password CSV", () => {
  it("reads browser headers, BOM, CRLF, quoted commas, quotes and multiline passwords without trimming secrets", () => {
    expect(parseLoginCsv('\uFEFFname,url,username,password\r\nExample,https://login.example.com/path,alice," a,b""c\nd "\r\n')).toEqual({
      ok: true, entries: [{ site: "https://login.example.com", username: "alice", password: ' a,b"c\nd ' }], invalidRows: [], duplicates: 0,
    });
    expect(parseLoginCsv('"url","username","password","httpRealm","timeCreated"\n"https://example.com","","secret","","123"')).toMatchObject({ ok: true, entries: [{ username: "", password: "secret" }] });
  });
  it("skips invalid origins and missing values, keeps separate accounts and skips repeated accounts", () => {
    const result = parseLoginCsv('url,username,password\nhttps://example.com,a,first\nhttps://example.com/path,A,second\nhttps://example.com,b,third\nhttp://example.com,c,fourth\nandroid://app,d,fifth\nhttps://user:secret@example.com,e,sixth\nhttps://example.com,f,');
    expect(result).toMatchObject({ ok: true, duplicates: 1, invalidRows: [5, 6, 7, 8], entries: [{ username: "a", password: "first" }, { username: "b", password: "third" }] });
  });
  it("rejects malformed and oversized input without reflecting any secret", () => {
    expect(parseLoginCsv('url,username,password\nhttps://example.com,a,"hidden')).toEqual({ ok: false, error: "csv" });
    expect(parseLoginCsv('url,username,password,password\na,b,c,d')).toEqual({ ok: false, error: "headers" });
    expect(parseLoginCsv('url,password\na,b')).toEqual({ ok: false, error: "headers" });
    expect(parseLoginCsv("x".repeat(LOGIN_IMPORT_MAX_BYTES + 1))).toEqual({ ok: false, error: "size" });
  });
});
