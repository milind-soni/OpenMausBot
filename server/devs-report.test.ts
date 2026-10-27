import { describe, expect, it } from "vitest";

import { buildDevsReport, contactAddress, DEVS_REPORT_LIMITS, environmentSecrets, redactReportText, withoutContact, type DevsReportInput } from "./devs-report.ts";

const ANTHROPIC = `sk-ant-${"a".repeat(40)}`;
const GITHUB = `ghp_${"b".repeat(36)}`;
const SLACK = `xoxb-${"1".repeat(12)}-${"c".repeat(24)}`;
const HELD = "plain-looking-value-without-a-shape";

function input(overrides: Partial<DevsReportInput> = {}): DevsReportInput {
  return {
    installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", appVersion: "0.1.128", platform: "darwin arm64, desktop app", os: "darwin 25.3.0 arm64",
    runsOn: "desktop app", node: "v24.1.0", uptimeSeconds: 7_380, language: "en", now: Date.UTC(2026, 9, 27, 9, 30),
    threadId: "thread-1", messageId: "message-1", where: "a chat with Scout",
    message: "@devs the send button froze", words: "the send button froze",
    bots: [{ id: "bot-1", name: "Scout", engine: "Claude Code", instanceId: "claude", model: "claude-opus-5-5", effort: "high", health: "available, signed in", apps: "not set up" }],
    problems: [], log: [], ...overrides,
  };
}

describe("a @devs report's redaction", () => {
  it("masks key shapes, bearer and basic authorization, cookies, URL credentials and parameters, and private keys", () => {
    const text = [
      `key ${ANTHROPIC} and ${GITHUB} and ${SLACK}`,
      "Authorization: Bearer abcdefghijklmnop123456",
      "authorization: Basic dXNlcjpwYXNzd29yZA==",
      "Cookie: session=abc123; theme=dark",
      "set-cookie: sid=zzz999; HttpOnly",
      "fetch https://ada:hunter22@api.example.com/v1/items?token=t0p&sig=abc#frag failed",
      "fetch https://token123@git.example.com/repo.git failed",
      "api_key=supersecretvalue123 password: hunter2hunter2",
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactReportText(text, []);
    for (const secret of [ANTHROPIC, GITHUB, SLACK, "abcdefghijklmnop123456", "dXNlcjpwYXNzd29yZA==", "abc123", "zzz999", "hunter22", "t0p", "frag",
      "token123", "supersecretvalue123", "hunter2hunter2", "MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA"]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain("https://«redacted credentials»@api.example.com/v1/items?«redacted URL parameters»");
    expect(out).toContain("git.example.com/repo.git");
  });

  it("masks the server's own secret values wherever they appear, whatever their shape", () => {
    const secrets = environmentSecrets({ OMB_OPENAI_API_KEY: HELD, COMPOSIO_API_KEY: "short", OMB_DATA_DIR: "/Users/ada/OpenMausBot" });
    expect(secrets).toEqual([HELD]);
    expect(redactReportText(`upstream said ${HELD}!`, secrets)).toBe(`upstream said «redacted ${HELD.length} chars»!`);
  });

  it("is stable: redacting a redacted text changes nothing", () => {
    const once = redactReportText(`see https://u:p@h.example/x?y=1 and Cookie: a=b and Authorization: Basic Zm9vOmJhcg== and ${ANTHROPIC}`, []);
    expect(redactReportText(once, [])).toBe(once);
  });

  it("keeps version numbers, ids and plain prose", () => {
    const text = "0.1.128 on darwin arm64; thread 9f1e-6d5a; the picture never loaded";
    expect(redactReportText(text, [])).toBe(text);
  });
});

describe("a @devs report's payload", () => {
  it("carries the person's message, the bot's summary and the facts, redacted, in the endpoint's fields", () => {
    const payload = buildDevsReport(input({
      message: `@devs it broke, my key is ${ANTHROPIC}`, words: `it broke, my key is ${ANTHROPIC}`,
      summary: { by: "Scout", text: { wentWrong: "Sending froze", seen: `The Bash tool failed with ${GITHUB}`, steps: "1. Send a picture" } },
      problems: ["2026-10-27T09:29:00.000Z tool Bash failed: exit code 1"], log: [`2026-10-27T09:29:01.000Z error upstream 401 Bearer ${"z".repeat(30)}`],
      contactEmail: " Ada@Example.com ",
    }), []);
    expect(Object.keys(payload).sort()).toEqual(["appVersion", "contact", "contactEmail", "description", "diagnostics", "installId", "platform", "source"]);
    expect(payload).toMatchObject({ source: "bot", appVersion: "0.1.128", platform: "darwin arm64, desktop app", contactEmail: "ada@example.com", contact: "ada@example.com" });
    expect(payload.description.split("\n")[0]).toBe(`it broke, my key is «redacted ${ANTHROPIC.length} chars»`);
    expect(payload.description).toContain("Scout's summary: Sending froze");
    expect(payload.description).toContain("Steps to reproduce: 1. Send a picture");
    expect(payload.diagnostics).toContain("Engine: Claude Code (claude), model claude-opus-5-5, effort high");
    expect(payload.diagnostics).toContain("tool Bash failed: exit code 1");
    expect(payload.diagnostics).toContain("Runs on: desktop app");
    expect(payload.diagnostics).toContain("Server uptime: 2h 3m");
    const whole = JSON.stringify(payload);
    for (const secret of [ANTHROPIC, GITHUB, "z".repeat(30)]) expect(whole).not.toContain(secret);
  });

  it("says why there is no summary when no bot wrote one, and leaves the address out when there is none", () => {
    const payload = buildDevsReport(input({ noSummary: "the bot did not call report_bug", contactEmail: "not an address" }), []);
    expect(payload.description).toContain("No summary from a bot: the bot did not call report_bug.");
    expect(payload.diagnostics).toContain("Summary from a bot: no, the bot did not call report_bug");
    expect(payload).not.toHaveProperty("contactEmail");
    expect(payload).not.toHaveProperty("contact");
    expect(buildDevsReport(input({ words: "" }), []).description.split("\n")[0]).toBe("(no words besides @devs)");
  });

  it("stays inside the endpoint's limits however much there is", () => {
    const huge = "x".repeat(50_000);
    const payload = buildDevsReport(input({
      message: huge, words: huge, appVersion: `0.1.128-${"b".repeat(80)}`, platform: `linux x64\n${"p".repeat(80)}`,
      summary: { by: "Scout", text: { wentWrong: huge, seen: huge, steps: huge } },
      problems: Array.from({ length: 500 }, (_, i) => `problem ${i} ${huge}`), log: Array.from({ length: 5_000 }, (_, i) => `line ${i} ${huge}`),
    }), []);
    expect(payload.description.length).toBeLessThanOrEqual(DEVS_REPORT_LIMITS.description);
    expect(payload.diagnostics.length).toBeLessThanOrEqual(DEVS_REPORT_LIMITS.diagnostics);
    expect(payload.appVersion.length).toBeLessThanOrEqual(40);
    expect(payload.platform.length).toBeLessThanOrEqual(40);
    expect(payload.platform).not.toMatch(/\p{Cc}/u);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(DEVS_REPORT_LIMITS.body);
    expect(payload.diagnostics).toContain("line 4999");
    expect(payload.diagnostics).not.toContain("line 4919 ");
  });

  it("drops both address fields together", () => {
    const payload = buildDevsReport(input({ contactEmail: "ada@example.com" }), []);
    expect(withoutContact(payload)).not.toHaveProperty("contactEmail");
    expect(withoutContact(payload)).not.toHaveProperty("contact");
  });
});

describe("the person's address", () => {
  it("is one the endpoint accepts, lower-cased, or nothing", () => {
    expect(contactAddress(" Ada@Example.COM ")).toBe("ada@example.com");
    for (const bad of ["", "ada", "ada@", "@example.com", "ada@example", "a b@example.com", `${"a".repeat(250)}@example.com`, undefined, null]) {
      expect(contactAddress(bad), String(bad)).toBeUndefined();
    }
  });
});
