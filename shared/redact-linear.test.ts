// Redaction runs on the server's only thread for every engine event, protocol line and tool result, so its work must grow
// with the text, never with its square: a quadratic pattern held a Cloud home's thread for minutes on one tool output of a
// few MB (a base64url blob), and the home stopped answering its health checks.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { redactSecretsInText } from "./redact.ts";

const MB = 1_048_576;
const timed = (text: string) => { const at = performance.now(); const out = redactSecretsInText(text); return { out, ms: performance.now() - at }; };

describe("redactSecretsInText on large text", () => {
  // Each took minutes before the name, scheme and JWT parts were bounded (2 MB of base64url: about 4 minutes, measured);
  // now well under a second each. The bound here is wide, so a slow machine never fails it.
  const shapes: Array<[string, () => string]> = [
    ["base64url", () => randomBytes(Math.ceil((2 * MB * 3) / 4)).toString("base64url").slice(0, 2 * MB)],
    ["hyphenated words", () => "ab-".repeat(MB / 3)],
    ["names ending in -key", () => "a-key".repeat(MB / 5)],
    ["JWT-like starts", () => `-eyJ${"a".repeat(30)}`.repeat(MB / 34)],
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
    const blob = randomBytes(300_000).toString("base64url");
    const text = `${blob} MY_SERVICE_API_KEY=abcd1234efgh ${blob}`;
    const out = redactSecretsInText(text);
    expect(out).not.toContain("abcd1234efgh");
    expect(out.startsWith(blob)).toBe(true);
    expect(out.endsWith(blob)).toBe(true);
  });
});

describe("redactSecretsInText with the bounded name parts", () => {
  it("masks a secret whose name carries a long prefix, up to the bound", () => {
    const prefix = "A".repeat(120);
    expect(redactSecretsInText(`${prefix}_API_KEY=abcd1234efgh`)).not.toContain("abcd1234efgh");
    expect(redactSecretsInText(`${"b".repeat(120)}-key=v4lue`)).not.toContain("v4lue");
  });

  it("masks a long hyphenated name by its last part", () => {
    const name = Array.from({ length: 60 }, () => "seg").join("-");
    expect(redactSecretsInText(`${name}-key=v4lue`)).not.toContain("v4lue");
    expect(redactSecretsInText(`${name}_token=abcd1234efgh`)).not.toContain("abcd1234efgh");
  });

  it("masks a JWT with a large payload, up to the bound", () => {
    const jwt = `eyJ${"h".repeat(40)}.${"p".repeat(12_000)}.${"s".repeat(342)}`;
    expect(redactSecretsInText(`Authorization header was ${jwt} here`)).not.toContain("p".repeat(100));
  });

  it("masks URL passwords and JWTs as before", () => {
    expect(redactSecretsInText("postgres://admin:hunter2pass@db.example.test/app")).not.toContain("hunter2pass");
    const jwt = `eyJ${"h".repeat(20)}.${"p".repeat(40)}.${"s".repeat(40)}`;
    expect(redactSecretsInText(`token ${jwt} end`)).not.toContain(jwt);
  });
});
