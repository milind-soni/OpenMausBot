// Redaction runs on the server's only thread for every engine event, protocol line and tool result, so its work must grow
// with the text, never with its square: a quadratic pattern held a Cloud home's thread for minutes on one tool output of a
// few MB (a base64url blob), and the home stopped answering its health checks.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { redactSecretsInText } from "./redact.ts";

const MB = 1_048_576;
// Random base64url can hold a real key's shape after a dash or underscore (`-sk-…`, `_ghp_…`), which redaction masks by
// design; with neither character there is no word boundary inside, so no key pattern can start in it.
const plainBlob = (bytes: number) => randomBytes(bytes).toString("base64url").replace(/[-_]/gu, "x");
const timed = (text: string) => { const at = performance.now(); const out = redactSecretsInText(text); return { out, ms: performance.now() - at }; };

describe("redactSecretsInText on large text", () => {
  // Each took seconds to minutes before (2 MB of base64url: about 4 minutes, measured; 2 MB of BEGIN lines with no END:
  // about 50 s); now well under a second each. The bound here is wide, so a slow machine never fails it.
  const shapes: Array<[string, () => string]> = [
    ["base64url", () => randomBytes(Math.ceil((2 * MB * 3) / 4)).toString("base64url").slice(0, 2 * MB)],
    ["hyphenated words", () => "ab-".repeat(MB / 3)],
    ["names ending in -key", () => "a-key".repeat(MB / 5)],
    ["JWT-like starts", () => `-eyJ${"a".repeat(30)}`.repeat(MB / 34)],
    ["private key BEGIN lines with no END", () => "fixtures/key.pem:-----BEGIN RSA PRIVATE KEY-----\n".repeat((2 * MB) / 50)],
    ["a long scheme-like run", () => `${"a".repeat(MB)}://`],
  ];
  for (const [name, make] of shapes) {
    it(`takes time in proportion to the text: ${name}`, () => {
      const text = make();
      const { out, ms } = timed(text);
      expect(ms).toBeLessThan(10_000);
      expect(out.length).toBeGreaterThan(0);
    });
  }

  it("still masks what it masked before, the blob around it unchanged", () => {
    const blob = plainBlob(300_000);
    const text = `${blob} MY_SERVICE_API_KEY=abcd1234efgh ${blob}`;
    const out = redactSecretsInText(text);
    expect(out).not.toContain("abcd1234efgh");
    expect(out.startsWith(blob)).toBe(true);
    expect(out.endsWith(blob)).toBe(true);
  });
});

describe("redactSecretsInText: names, schemes, JWTs and key blocks of any length", () => {
  it("masks a secret whose name has a long prefix, the name kept as it was", () => {
    const name = `${"A".repeat(140)}_API_KEY`;
    expect(redactSecretsInText(`${name}=abcd1234efgh`)).toBe(`${name}=«redacted 12 chars»`);
    expect(redactSecretsInText(`${"SEG_".repeat(35)}TOKEN=abcd1234efgh`)).not.toContain("abcd1234efgh");
    expect(redactSecretsInText(`${"b".repeat(140)}-key=v4lue`)).toBe(`${"b".repeat(140)}-key=«redacted 5 chars»`);
    const hyphens = Array.from({ length: 60 }, () => "seg").join("-");
    expect(redactSecretsInText(`${hyphens}-key=v4lue`)).not.toContain("v4lue");
    expect(redactSecretsInText(`${hyphens}_token=abcd1234efgh`)).not.toContain("abcd1234efgh");
  });

  it("masks a URL password after a scheme of 40 characters", () => {
    const scheme = "a".repeat(40);
    expect(redactSecretsInText(`${scheme}://user:hunter2pass@host`)).toBe(`${scheme}://user:«redacted 11 chars»@host`);
    expect(redactSecretsInText("postgres://admin:hunter2pass@db.example.test/app")).not.toContain("hunter2pass");
  });

  it("masks a JWT whatever its size, and only from a word boundary to one", () => {
    for (const payload of [40, 12_000, 40_000]) {
      const jwt = `eyJ${"h".repeat(40)}.${"p".repeat(payload)}.${"s".repeat(342)}`;
      expect(redactSecretsInText(`token was ${jwt} here`)).toBe(`token was «redacted ${jwt.length} chars» here`);
    }
    const jwt = `eyJ${"h".repeat(20)}.${"p".repeat(40)}.${"s".repeat(40)}`;
    // Trailing dashes are not part of it; one glued to a word is not one; a short part makes none.
    expect(redactSecretsInText(`(${jwt}--)`)).toBe(`(«redacted ${jwt.length} chars»--)`);
    expect(redactSecretsInText(`x${jwt}`)).toBe(`x${jwt}`);
    expect(redactSecretsInText(`a eyJhhhhhhhh.pppp.ssssssssss b`)).toBe("a eyJhhhhhhhh.pppp.ssssssssss b");
    // In a long run of base64url, after a dash.
    const blob = plainBlob(50_000);
    expect(redactSecretsInText(`${blob}-${jwt} z`)).toBe(`${blob}-«redacted ${jwt.length} chars» z`);
  });

  it("masks each private key block up to its first END, and leaves a BEGIN with no END as it was", () => {
    const block = (body: string) => `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    expect(redactSecretsInText(`a ${block("MIIEsecret1")} b ${block("MIIEsecret22")} c`))
      .toBe(`a -----BEGIN RSA PRIVATE KEY-----\n«redacted 11 chars»\n-----END RSA PRIVATE KEY----- b -----BEGIN RSA PRIVATE KEY-----\n«redacted 12 chars»\n-----END RSA PRIVATE KEY----- c`);
    const open = "-----BEGIN PRIVATE KEY-----\nMIIEnoend";
    expect(redactSecretsInText(open)).toBe(open);
  });
});
