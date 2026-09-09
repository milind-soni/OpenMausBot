import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  buildDiagnosticsReport,
  decodeLogTail,
  diagnosticsFileName,
  formatDesktopCrashRecord,
  installDesktopCrashListeners,
  readSafeLogTail,
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
    expect(report).toContain("(no desktop crash events available)");
    expect(report).toContain("(server log unavailable)");
    expect(report).toContain("(updater log unavailable)");
  });

  it("includes updater diagnostics separately and redacts signed redirects and headers", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      logTail: "server ready",
      updaterLogTail: [
        "[info] Downloading version 0.1.61",
        "[error] GET https://release-assets.example.test/update.zip?X-Amz-Credential=private-account&X-Amz-Signature=signed-secret&jwt=private-jwt HTTP 403",
        'headers {"authorization":"Basic dXNlcjpwYXNzd29yZA==","apiKey":"opaque-private-key"}',
        "Set-Cookie: session=private-session; Secure; HttpOnly",
      ].join("\n"),
    });
    expect(report).toContain("## Updater log tail — credentials and URL parameters auto-masked");
    expect(report).toContain("Downloading version 0.1.61");
    expect(report).toContain("https://release-assets.example.test/update.zip?«redacted URL parameters» HTTP 403");
    for (const secret of ["private-account", "signed-secret", "private-jwt", "dXNlcjpwYXNzd29yZA==", "opaque-private-key", "private-session"]) {
      expect(report).not.toContain(secret);
    }
    expect(report.indexOf("server ready")).toBeLessThan(report.indexOf("Downloading version 0.1.61"));
  });

  it.each(["", null, undefined])("handles an absent updater log (%s)", (updaterLogTail) => {
    expect(buildDiagnosticsReport({ appInfo, updaterLogTail })).toContain("(updater log unavailable)");
  });

  it("removes URL userinfo, fragments, and unfamiliar query capabilities without hiding public paths", () => {
    const line = "GET https://private-user:private-password@updates.example.test/update.zip?%73ig=encoded-secret#fragment-secret\n"
      + "GET https://updates.example.test/latest-mac.yml\n"
      + "GET https://updates.example.test/update.zip#private-fragment";
    const redacted = redactSecretsInLine(line);
    expect(redacted).toContain("https://«redacted credentials»@updates.example.test/update.zip?«redacted URL parameters»");
    expect(redacted).toContain("https://updates.example.test/latest-mac.yml");
    for (const secret of ["private-user", "private-password", "encoded-secret", "fragment-secret", "private-fragment"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("masks JSON credential fields and cookies in updater HTTP dumps", () => {
    const redacted = redactSecretsInLine([
      '{"OMB_COMPOSIO_BROKER_TOKEN":"opaque-broker-value","password":"opaque-password-value"}',
      '{"Cookie":"session=private-cookie; tracking=private-tracker"}',
      "Cookie: session=private-session; tracking=private-tracking",
    ].join("\n"));
    for (const secret of ["opaque-broker-value", "opaque-password-value", "private-cookie", "private-tracker", "private-session", "private-tracking"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("includes privacy-safe desktop crash metadata separately from the server log", () => {
    const desktopLogTail =
      "[2026-08-31T11:00:00.000Z] event=render-process-gone surface=main-window reason=crashed exitCode=5";
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      desktopLogTail,
      logTail: "server ready",
    });
    expect(report).toContain("## Desktop crash events — privacy-safe metadata only");
    expect(report).toContain(desktopLogTail);
    expect(report.indexOf(desktopLogTail)).toBeLessThan(report.indexOf("server ready"));
  });

  it("redacts desktop crash lines again before exporting them", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      desktopLogTail: "event=future-crash token=abcdefghijklmnop",
      logTail: "",
    });
    expect(report).not.toContain("abcdefghijklmnop");
    expect(report).toContain("token=«redacted");
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

describe("formatDesktopCrashRecord", () => {
  it("records renderer and child failures without accepting arbitrary fields", () => {
    expect(
      formatDesktopCrashRecord({
        kind: "renderer",
        surface: "main-window",
        reason: "crashed",
        exitCode: 9,
        url: "https://example.test/private?token=secret",
      }),
    ).toBe("event=render-process-gone surface=main-window reason=crashed exitCode=9");
    expect(
      formatDesktopCrashRecord({
        kind: "child",
        type: "GPU",
        reason: "oom",
        exitCode: 34,
        commandLine: "--password=secret",
      }),
    ).toBe("event=child-process-gone type=GPU reason=oom exitCode=34");
  });

  it("omits normal clean exits", () => {
    expect(formatDesktopCrashRecord({ kind: "renderer", reason: "clean-exit" })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "child", reason: "clean-exit" })).toBeNull();
  });

  it("reduces a fatal main-process error to its type without reading its message or stack", () => {
    const error = new TypeError("secret user text from C:\\Users\\Ada\\private.txt");
    error.stack = [
      "TypeError: secret user text from C:\\Users\\Ada\\private.txt",
      "secret-client.ts:1:1",
      "    at boot (file:///C:/Users/Ada/OpenMausBot/electron/main.mjs:412:7)",
    ].join("\n");
    const record = formatDesktopCrashRecord({ kind: "main", origin: "unhandledRejection", error });
    expect(record).toBe("event=main-process-failure origin=unhandledRejection error=TypeError");
    expect(record).not.toContain("Ada");
    expect(record).not.toContain("secret user text");
    expect(record).not.toContain("secret-client");
  });

  it("fails closed for unknown Electron metadata", () => {
    expect(
      formatDesktopCrashRecord({
        kind: "renderer",
        surface: "private-window-name",
        reason: "token=super-secret",
        exitCode: "5; password=secret",
      }),
    ).toBe("event=render-process-gone surface=auxiliary reason=unknown exitCode=unknown");
    expect(formatDesktopCrashRecord({ kind: "anything", payload: "secret" })).toBeNull();
  });
});

describe("installDesktopCrashListeners", () => {
  it("observes fatal, renderer and child failures through structural fields only", () => {
    const appTarget = new EventEmitter();
    const processTarget = new EventEmitter();
    const records = [];
    const mainContents = {};
    const dispose = installDesktopCrashListeners({
      appTarget,
      processTarget,
      record: (event) => records.push(event),
      mainWebContents: () => mainContents,
    });
    const error = new TypeError("private message");
    processTarget.emit("uncaughtExceptionMonitor", error, "unhandledRejection");
    appTarget.emit(
      "render-process-gone",
      {},
      mainContents,
      { reason: "crashed", exitCode: 7, url: "https://private.test" },
    );
    appTarget.emit(
      "child-process-gone",
      {},
      { type: "GPU", reason: "oom", exitCode: 34, name: "private-service" },
    );
    expect(records).toEqual([
      { kind: "main", error, origin: "unhandledRejection" },
      { kind: "renderer", surface: "main-window", reason: "crashed", exitCode: 7 },
      { kind: "child", type: "GPU", reason: "oom", exitCode: 34 },
    ]);
    dispose();
    expect(processTarget.listenerCount("uncaughtExceptionMonitor")).toBe(0);
    expect(appTarget.listenerCount("render-process-gone")).toBe(0);
    expect(appTarget.listenerCount("child-process-gone")).toBe(0);
  });

  it("ignores process exits after Electron has begun its normal shutdown", () => {
    const appTarget = new EventEmitter();
    const processTarget = new EventEmitter();
    const records = [];
    installDesktopCrashListeners({
      appTarget,
      processTarget,
      record: (event) => records.push(event),
      isShuttingDown: () => true,
    });
    appTarget.emit("render-process-gone", {}, {}, { reason: "killed", exitCode: 0 });
    appTarget.emit("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: 0 });
    expect(records).toEqual([]);
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

describe("readSafeLogTail", () => {
  it("exports only a bounded complete-line updater tail from an isolated log fixture", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmausbot-updater-diagnostics-"));
    try {
      const log = join(directory, "updater.log");
      const tail = "[info] update staged\n[error] https://updates.example.test/app.zip?jwt=private-query-token\n";
      writeFileSync(log, `${"old-private-line\n".repeat(20_000)}${tail}`, { mode: 0o600 });
      const result = readSafeLogTail(log);
      expect(result.bytes).toBeLessThanOrEqual(256 * 1024);
      expect(result.tail.endsWith(tail)).toBe(true);
      const report = buildDiagnosticsReport({ updaterLogTail: result.tail });
      expect(report).toContain("[info] update staged");
      expect(report).not.toContain("private-query-token");
      expect(report).not.toContain(directory);
      expect(readSafeLogTail(join(directory, "absent-updater.log"))).toBeNull();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reads a bounded tail from a regular app-owned log", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmausbot-log-tail-"));
    try {
      const log = join(directory, "server.log");
      writeFileSync(log, "partial-secret\nfirst\nsecond\n", { mode: 0o600 });
      expect(readSafeLogTail(log, 17)).toEqual({ tail: "first\nsecond\n", bytes: 13 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a log-path symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmausbot-log-symlink-"));
    try {
      const privateFile = join(directory, "private.txt");
      const log = join(directory, "desktop-crashes.log");
      writeFileSync(privateFile, "private user content", { mode: 0o600 });
      symlinkSync(privateFile, log);
      expect(readSafeLogTail(log)).toBeNull();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("diagnosticsFileName", () => {
  it("uses openmausbot-diagnostics-YYYYMMDD-HHmmss.txt", () => {
    expect(diagnosticsFileName(new Date(2026, 7, 22, 16, 5, 9))).toBe(
      "openmausbot-diagnostics-20260822-160509.txt",
    );
  });
});
