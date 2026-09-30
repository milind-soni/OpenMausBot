import { describe, expect, it } from "vitest";
import { redactContentClasses } from "./content-class.ts";
import { redactSecretsInText } from "./redact.ts";

describe("content-class classification", () => {
  it("masks personal data spans with the shared marker", () => {
    const text = "Email jane.doe@example.com or call 416-555-0142 / +1 (416) 555-0143, ssn 123-45-6789, card 4111 1111 1111 1111";
    const { text: out, passed } = redactContentClasses(text, ["personal"]);
    expect(passed).toEqual([]);
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).not.toContain("416-555-0142");
    expect(out).not.toContain("555-0143");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("4111 1111 1111 1111");
    expect((out.match(/«redacted \d+ chars»/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("masks internal infrastructure but never a public address", () => {
    const text = "ssh 10.0.7.24 or db.internal or fd00::1 or fe80::1 or 192.168.1.10 or ::1; public 8.8.8.8 and example.com stay";
    const { text: out, passed } = redactContentClasses(text, ["internal"]);
    expect(passed).toEqual([]);
    expect(out).toContain("8.8.8.8");
    expect(out).toContain("example.com");
    expect(out).not.toContain("10.0.7.24");
    expect(out).not.toContain("db.internal");
    expect(out).not.toContain("fd00::1");
    expect(out).not.toContain("fe80::1");
    expect(out).not.toContain("192.168.1.10");
    expect(out).not.toContain("::1");
  });

  it("leaves ordinary text untouched: dates, versions, ids, times", () => {
    const text = "On 2026-09-22 v1.2.3 build 8675309 task #12345 ran at 12:30 for 3.5 hours in region eu-west-1";
    expect(redactContentClasses(text, ["personal", "internal"]).text).toBe(text);
  });

  it("reports loosened classes without masking their spans", () => {
    const text = "jane@example.com on 10.0.0.5";
    expect(redactContentClasses(text, ["internal"])).toEqual({ text: "jane@example.com on «redacted 8 chars»", passed: ["personal"] });
    expect(redactContentClasses(text, ["personal"])).toEqual({ text: "«redacted 16 chars» on 10.0.0.5", passed: ["internal"] });
    expect(redactContentClasses(text, [])).toEqual({ text, passed: ["personal", "internal"] });
    expect(redactContentClasses("plain prose", ["personal"])).toEqual({ text: "plain prose", passed: [] });
  });

  it("masks a card fused with an adjacent digit group", () => {
    const card = "4111111111111111";
    // the fused candidate is 20 digits as a whole and would be rejected;
    // the card inside it must still be found and masked
    expect(redactContentClasses(`${card} 1234`, ["personal"])).toEqual({ text: "«redacted 16 chars» 1234", passed: [] });
    expect(redactContentClasses(`1234 ${card}`, ["personal"]).text).toBe("1234 «redacted 16 chars»");
    // detection agrees when the class is loosened
    expect(redactContentClasses(`${card} 1234`, ["internal"]).passed).toEqual(["personal"]);
  });

  it("masks the union of overlapping Luhn-valid card windows", () => {
    const fused = "0006 4111 1111 1111 1111";
    expect(redactContentClasses(fused, ["personal"])).toEqual({ text: "«redacted 24 chars»", passed: [] });
  });

  it("classifies complete IPv6 addresses, never an internal-looking fragment", () => {
    const text = "nat 2606:4700::fd00:1 edge; locals fd00::1 fc00::1 fe80::1 ::1 ::ffff:c0a8:0101 ::ffff:192.168.1.1";
    const { text: out, passed } = redactContentClasses(text, ["internal"]);
    expect(passed).toEqual([]);
    // the global address keeps its fd00:1 fragment; only real locals go
    expect(out).toContain("2606:4700::fd00:1");
    expect(out).not.toContain("fd00::1");
    expect(out).not.toContain("fc00::1");
    expect(out).not.toContain("fe80::1");
    expect(out).not.toContain("::ffff:c0a8:0101");
    expect(out).not.toContain("::ffff:192.168.1.1");
    // loosened detection reports internal only for genuinely internal spans
    expect(redactContentClasses("2606:4700::fd00:1", []).passed).toEqual([]);
    expect(redactContentClasses("fd00::1", []).passed).toEqual(["internal"]);
  });

  it("leaves times, MACs, mapped public addresses and documentation prefixes untouched", () => {
    const text = "at 12:34:56 nic 00:1a:2b:3c:4d:5e nat ::ffff:8.8.8.8 doc 2001:db8::1";
    expect(redactContentClasses(text, ["internal"]).text).toBe(text);
  });

  it("is stable across re-application", () => {
    const once = redactContentClasses("card 4111111111111111 ends", ["personal"]).text;
    expect(redactContentClasses(once, ["personal"]).text).toBe(once);
  });
  it("masks with markers byte-identical to the credential scrub", () => {
    const mixed = "token sk-ant-api03-1234567890abcdef1234567890abcdef for jane@example.com";
    const creds = redactSecretsInText(mixed);
    expect(creds).toContain("«redacted ");
    expect(creds).not.toContain("sk-ant-api03-1234567890abcdef1234567890abcdef");
    const both = redactContentClasses(creds, ["personal"]).text;
    expect(both).not.toContain("jane@example.com");
    expect(both).toContain("«redacted 16 chars»");
    // a payload can pass through both scrubs; neither may re-mask a marker
    expect(redactSecretsInText(both)).toBe(both);
    expect(redactContentClasses(both, ["personal", "internal"]).text).toBe(both);
  });
});
