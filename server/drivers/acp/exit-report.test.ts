import { describe, expect, it } from "vitest";

import { StderrTail, exitDetail, exitInWords, maskDiagnosticLine } from "./exit-report.ts";

// Google's Antigravity runtime in the bot box without /sys, Fly Cloud home 2026-11-04: its whole stderr before exit 134.
const TCMALLOC_ABORT = "2 third_party/tcmalloc/internal/sysinfo.h:76] CHECK in NumCPUs: maybe_cpus.has_value() (false) ";

describe("an engine's exit in plain words", () => {
  it("names what an exit code or signal means, including a signal a wrapper reports as 128 + N", () => {
    expect(exitInWords(134)).toBe("it stopped itself (abort)");
    expect(exitInWords(null, "SIGABRT")).toBe("it stopped itself (abort)");
    expect(exitInWords(137)).toMatch(/killed, often for running out of memory/u);
    expect(exitInWords(null, "SIGKILL")).toMatch(/killed/u);
    expect(exitInWords(139)).toBe("it crashed");
    expect(exitInWords(132)).toMatch(/instruction this CPU does not have/u);
    expect(exitInWords(159)).toMatch(/system call the sandbox refuses/u);
    expect(exitInWords(127)).toBe("a program it needs was not found");
    expect(exitInWords(126)).toBe("a program it needs could not be run");
    for (const plain of [0, 1, 3, 255, null]) expect(exitInWords(plain), String(plain)).toBeNull();
  });

  it("puts the meaning before the last output, and adds nothing when neither is known", () => {
    expect(exitDetail(134, null, "CHECK failed")).toBe(": it stopped itself (abort). Last output: CHECK failed");
    expect(exitDetail(134, null, "")).toBe(": it stopped itself (abort)");
    expect(exitDetail(3, null, "panicked at src/main.rs")).toBe(": panicked at src/main.rs");
    expect(exitDetail(1, null, "")).toBe("");
  });
});

describe("masking an engine's diagnostic lines", () => {
  it("keeps a crash line whole", () => {
    expect(maskDiagnosticLine(TCMALLOC_ABORT)).toBe(TCMALLOC_ABORT.trim());
    expect(maskDiagnosticLine("Error code: ENOENT, open '/data/x.json'")).toBe("Error code: ENOENT, open '/data/x.json'");
    expect(maskDiagnosticLine("worker exit code=134")).toBe("worker exit code=134");
  });

  it("masks what a sign-in prints: a link's query, Google's code and token shapes, and a value after a secret's name", () => {
    const lines = [
      "Open https://accounts.google.com/o/oauth2/v2/auth?state=private-state&code_challenge=private-challenge",
      "callback http://127.0.0.1:53681/?code=4/0AVGzR1private-code-value&state=private-state",
      "got 4/0AVGzR1privatecodevalue1234 and ya29.a0Private-access.token",
      "refresh 1//0gPrivateRefreshToken-xyz",
      "private auth code: do-not-disclose",
      "client GOCSPX-private-client-secret",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "key sk-ant-api03-privatekeyvalue1234567890",
      "session=0123456789abcdef0123456789abcdef0123",
      "verify code=739201",
    ];
    const masked = lines.map(maskDiagnosticLine).join("\n");
    for (const secret of ["private-state", "private-challenge", "private-code-value", "privatecodevalue", "ya29.a0Private", "PrivateRefreshToken",
      "do-not-disclose", "private-client-secret", "abcdefghijklmnopqrstuvwxyz", "privatekeyvalue", "0123456789abcdef0123", "739201"]) {
      expect(masked, secret).not.toContain(secret);
    }
    expect(masked).toContain("https://accounts.google.com/o/oauth2/v2/auth?«redacted");
    expect(masked).toContain("private auth code: «redacted");
  });

  it("caps a long line", () => {
    expect(maskDiagnosticLine(`fatal: ${"word ".repeat(200)}`).length).toBeLessThanOrEqual(301);
  });
});

describe("the last stderr lines", () => {
  it("keeps the last three whole lines, masked as they arrive, and the unfinished one only once flushed", () => {
    const tail = new StderrTail();
    tail.write("one\ntwo\n\nthree\ntoken=private-token-value\nfour");
    expect(tail.text).toBe("two | three | token=«redacted 19 chars»");
    tail.flush();
    expect(tail.text).toBe("three | token=«redacted 19 chars» | four");
    tail.clear();
    expect(tail.text).toBe("");
  });

  it("joins a line split across writes, and drops an overlong line unread to its end", () => {
    const tail = new StderrTail(3, 16);
    tail.write("CHECK in Num");
    tail.write("CPUs\n");
    tail.write("x".repeat(40));
    tail.write("unlabeled-value-at-the-end");
    tail.write("\nlast\n");
    expect(tail.text).toBe("CHECK in NumCPUs | last");
  });

  it("never keeps a private key's lines, even split across writes", () => {
    const tail = new StderrTail();
    tail.write("loading\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow+IBAAKC/AQEA");
    tail.write("x9+/Zq==\nQUJDREVG+/gh\n-----END RSA PRIVATE KEY-----\nready\n");
    expect(tail.text).toBe("loading | -----BEGIN PRIVATE KEY----- «redacted» | ready");
    tail.clear();
    tail.note("-----BEGIN PRIVATE KEY-----");
    tail.note("MIIEvQIBADAN+Bgkqh/kiG9w0BAQEFAASC");
    expect(tail.text).toBe("-----BEGIN PRIVATE KEY----- «redacted»");
  });
});
