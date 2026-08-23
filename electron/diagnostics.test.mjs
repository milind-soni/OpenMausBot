import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  buildDiagnosticsReport,
  decodeLogTail,
  diagnosticsFileName,
  redactSecretsInLine,
  CREDENTIAL_ENV_NAMES,
} = require("./diagnostics.mjs");

// The desktop shell cannot import TypeScript, so its credential list is a
// hand copy of server/config.ts WORKSPACE_CREDENTIAL_ENV. This test is the
// drift alarm: a name added server-side without updating the copy here would
// otherwise ship an unredacted export path.
describe("credential env parity with server/config.ts", () => {
  it("matches WORKSPACE_CREDENTIAL_ENV exactly", () => {
    const config = readFileSync(new URL("../server/config.ts", import.meta.url), "utf8");
    const match = config.match(/WORKSPACE_CREDENTIAL_ENV = \[([\s\S]*?)\] as const/);
    expect(match).not.toBeNull();
    const names = [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(CREDENTIAL_ENV_NAMES).toEqual(names);
  });
});

describe("buildDiagnosticsReport", () => {
  const appInfo = {
    version: "0.1.27",
    platform: "darwin",
    arch: "arm64",
    electron: "43.4.0",
    node: "24.0.0",
    packaged: true,
    uptimeSeconds: 42,
  };

  it("renders app facts and a sorted config summary", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {
        xai: { configured: true },
        box: { configured: false },
        rooms: { turnTimeoutMinutes: 5 },
      },
      logTail: "",
    });
    expect(report).toContain("version=0.1.27");
    expect(report).toContain("platform=darwin");
    expect(report).toContain("arch=arm64");
    expect(report).toContain("xai.configured=true");
    expect(report).toContain("box.configured=false");
    expect(report).toContain("rooms.turnTimeoutMinutes=5");
    expect(report).toContain("(server log unavailable)");
  });

  it("drops strings, non-scalars and credential-shaped summary values", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {
        xai: { key: "xai-real-secret" },
        composio: { apiKey: "ak_live_abcdef123456789" },
        vps: { sshAlias: "" },
        profile: { name: "Ada" },
        instances: [{ driver: "claudeAgent", environment: { TOKEN: "hunter2" } }],
        note: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      },
      logTail: "",
    });
    expect(report).not.toContain("xai-real-secret");
    expect(report).not.toContain("ak_live_abcdef123456789");
    expect(report).not.toContain("hunter2");
    expect(report).not.toContain("driver");
    expect(report).not.toContain("environment");
    expect(report).not.toContain("profile.name=");
    expect(report).not.toContain("Ada");
    expect(report).not.toContain("note=");
  });

  it("never includes an absolute log path in the report heading", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: "server ready",
      logPath: "/Users/ada/Library/Logs/OpenMausBot/server.log",
    });
    expect(report).toContain("## Server log tail");
    expect(report).not.toContain("/Users/ada");
  });

  it.each(CREDENTIAL_ENV_NAMES)("masks any value riding on %s in the log tail", (name) => {
    const value = "s3cr3t-value-123456";
    const line = `spawn env ${name}=${value} ready`;
    const report = buildDiagnosticsReport({ appInfo, configSummary: {}, logTail: line });
    expect(report).not.toContain(value);
    expect(redactSecretsInLine(line)).toBe(`spawn env ${name}=«redacted ${value.length} chars» ready`);
  });

  it("masks generic key=value secrets and content-shaped tokens in the log tail", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: [
        'config {"apiKey":"sk-proj-abcdefghijklmnop"}',
        "Authorization: Bearer abcdefghijklmnop",
        "password=hunter2000",
      ].join("\n"),
    });
    expect(report).not.toContain("sk-proj-abcdefghijklmnop");
    expect(report).not.toContain("abcdefghijklmnop");
    expect(report).not.toContain("hunter2000");
    expect(report).toContain("«redacted");
  });

  it.each(["Bearer abcdefghijklmnop", "Basic dXNlcjpwYXNzd29yZA=="])(
    "masks the full Authorization credential for %s",
    (authorization) => {
      const report = buildDiagnosticsReport({
        appInfo,
        configSummary: {},
        logTail: `request Authorization: ${authorization}`,
      });
      expect(report).not.toContain(authorization);
      expect(report).not.toContain(authorization.split(" ")[1]);
      expect(report).toContain("Authorization=«redacted");
    },
  );

  it("masks a multiline PEM private key as one value", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: [
        "loading credential",
        "-----BEGIN PRIVATE KEY-----",
        "super-secret-line-one",
        "super-secret-line-two",
        "-----END PRIVATE KEY-----",
        "ready",
      ].join("\n"),
    });
    expect(report).not.toContain("super-secret-line-one");
    expect(report).not.toContain("super-secret-line-two");
    expect(report).toContain("«redacted private key»");
  });

  it("leaves ordinary log lines untouched", () => {
    const line = "[2026-08-22T20:00:00.000Z] [out] fork server/index.js port=8799 spawned pid=4242";
    expect(redactSecretsInLine(line)).toBe(line);
  });

  it("handles an empty or missing log gracefully", () => {
    for (const logTail of ["", null, undefined]) {
      const report = buildDiagnosticsReport({ appInfo, configSummary: {}, logTail });
      expect(report).toContain("(server log unavailable)");
      expect(report.endsWith("\n")).toBe(true);
    }
  });

  it("keeps long prose lines that merely mention a key by name", () => {
    const line = "user asked whether the XAI_API_KEY variable needs to be set manually";
    expect(redactSecretsInLine(line)).toBe(line);
  });
});

describe("decodeLogTail", () => {
  it("preserves the full buffer when the read starts at the beginning", () => {
    expect(decodeLogTail(Buffer.from("first\nsecond"), false)).toEqual({ tail: "first\nsecond", bytes: 12 });
  });

  it("drops a credential assignment split by a bounded tail read", () => {
    const decoded = decodeLogTail(Buffer.from("RET=split-secret\nserver ready\n"), true);
    expect(decoded).toEqual({ tail: "server ready\n", bytes: 13 });
    expect(decoded.tail).not.toContain("split-secret");
  });

  it("returns an empty tail when a truncated buffer has no complete line", () => {
    expect(decodeLogTail(Buffer.from("partial-secret"), true)).toEqual({ tail: "", bytes: 0 });
  });
});

describe("diagnosticsFileName", () => {
  it("uses openmausbot-diagnostics-YYYYMMDD-HHmmss.txt", () => {
    expect(diagnosticsFileName(new Date(2026, 7, 22, 16, 5, 9))).toBe(
      "openmausbot-diagnostics-20260822-160509.txt",
    );
  });
});
