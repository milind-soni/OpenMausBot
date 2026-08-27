import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { capabilityDigest, parkedCapability } from "../src/capability.ts";
import { formatPermissions } from "../src/permissions.ts";
import { asDigest, parseRequest } from "../src/wire.ts";
import {
  activeCapabilityPath,
  childEnvironment,
  cuaSocket,
  policyPath,
  supportDirectory,
} from "../src/platform.ts";
import {
  MAC_CAPABILITY_RELATIVE,
  MAC_CUA_SOCKET_RELATIVE,
  MAC_POLICY_RELATIVE,
} from "../../server/mac-worker.ts";
import { WINDOWS_CUA_PIPE } from "../../server/windows-worker.ts";

// The companion ships to the worker as a standalone package, so it embeds the
// parked manifest rather than importing docs/. That duplication is only safe
// while the two stay byte-identical: an operator who installs the documented
// file and a companion that writes a different one disagree on the digest, and
// the worker never comes up bounded. This is the test that keeps them honest.
describe("parked capability", () => {
  it.each([
    ["darwin", "docs/macos-parked-capabilities.yaml"],
    ["win32", "docs/windows-parked-capabilities.yaml"],
  ] as const)("embedded %s manifest matches the documented file", (platform, docPath) => {
    // Line endings are normalised because this asserts *content* drift, and a
    // Windows checkout may convert them. The separate hazard — that a CRLF copy
    // hashes differently from the LF one the companion writes — is handled at
    // source by the `text eol=lf` rules in .gitattributes, not here.
    const documented = readFileSync(new URL(`../../${docPath}`, import.meta.url), "utf8");
    expect(parkedCapability(platform).replace(/\r\n/g, "\n")).toBe(documented.replace(/\r\n/g, "\n"));
  });

  it("grants no tools on either platform", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(parkedCapability(platform)).toContain("tools: []");
    }
  });

  it("digests the exact bytes it is given", () => {
    // sha256 of the empty string — proves no trimming or normalisation.
    expect(capabilityDigest("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

// The control plane greps the companion's stdout with a fixed pattern
// (server/mac-worker.ts). These assertions are that contract written down: if
// the JSON shape drifts, the probe silently reads "not granted" forever and
// every macOS worker fails at worker_accessibility_denied with nothing obviously
// wrong on the guest.
describe("--permissions output", () => {
  const GRANTED = /"accessibility"[\s]*:[\s]*true/;
  const RECORDING = /"screenRecording"[\s]*:[\s]*true/;

  it("matches the probe's pattern when both are granted", () => {
    const line = formatPermissions({ accessibility: true, screenRecording: true });
    expect(line).toBe('{"accessibility":true,"screenRecording":true}');
    expect(line).toMatch(GRANTED);
    expect(line).toMatch(RECORDING);
  });

  it("fails closed for every non-granted shape", () => {
    for (const report of [
      { accessibility: false, screenRecording: true },
      { accessibility: true, screenRecording: false },
      { accessibility: null, screenRecording: null },
    ] as const) {
      const line = formatPermissions(report);
      const bothGranted = GRANTED.test(line) && RECORDING.test(line);
      expect(bothGranted).toBe(false);
    }
  });

  it("emits a single line so a grep cannot straddle records", () => {
    expect(formatPermissions({ accessibility: true, screenRecording: true })).not.toContain("\n");
  });
});

// The companion cannot import the server's constants at runtime, so these
// assert the two independently-declared copies still describe one desktop.
describe("platform paths agree with the server adapters", () => {
  it("resolves the macOS socket, policy and capability the probe reads", () => {
    expect(cuaSocket("darwin")).toBe(join(homedir(), ...MAC_CUA_SOCKET_RELATIVE.split("/")));
    expect(policyPath("darwin")).toBe(join(homedir(), ...MAC_POLICY_RELATIVE.split("/")));
    expect(activeCapabilityPath("darwin")).toBe(join(homedir(), ...MAC_CAPABILITY_RELATIVE.split("/")));
  });

  it("uses the fixed Windows pipe the probe connects to", () => {
    expect(cuaSocket("win32")).toBe(WINDOWS_CUA_PIPE);
  });

  it("keeps the capability beside the policy", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(activeCapabilityPath(platform).startsWith(supportDirectory(platform))).toBe(true);
      expect(policyPath(platform).startsWith(supportDirectory(platform))).toBe(true);
    }
  });
});

describe("child environment", () => {
  const MAC_ALLOWED = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG"];

  it("passes only allow-listed names through", () => {
    const env = childEnvironment("darwin");
    expect(Object.keys(env).every((name) => MAC_ALLOWED.includes(name))).toBe(true);
  });

  it("drops any variable outside the list, whatever the SSH session carried", () => {
    const probe = "OMB_UNLISTED_PROBE_VARIABLE";
    const before = process.env[probe];
    process.env[probe] = "should-not-propagate";
    try {
      for (const platform of ["darwin", "win32"] as const) {
        expect(childEnvironment(platform)).not.toHaveProperty(probe);
      }
    } finally {
      if (before === undefined) delete process.env[probe];
      else process.env[probe] = before;
    }
  });
});

// The wire is the companion's entire attack surface. These assert what it
// refuses, not just what it accepts: the security claim in the README is that
// a request can name an operation and a digest and nothing else.
describe("stdio request parsing", () => {
  it("accepts pause", () => {
    expect(parseRequest('{"op":"pause"}')).toEqual({ op: "pause" });
  });

  it("accepts resume with a valid digest", () => {
    const digest = "a".repeat(64);
    expect(parseRequest(`{"op":"resume","expectedBasePolicySha256":"${digest}"}`)).toEqual({
      op: "resume",
      expectedBasePolicySha256: digest,
    });
  });

  it("accepts an explicit matching protocol version", () => {
    expect(parseRequest('{"version":1,"op":"pause"}')).toEqual({ version: 1, op: "pause" });
  });

  it("rejects a mismatched protocol version", () => {
    expect(() => parseRequest('{"version":2,"op":"pause"}')).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseRequest("{not json")).toThrow("invalid JSON");
  });

  it.each([
    ["unknown op", '{"op":"exfiltrate"}'],
    ["missing op", "{}"],
    ["task-layer op not in this release", '{"op":"run","taskId":"t","commandId":"c"}'],
  ])("rejects %s", (_label, line) => {
    expect(() => parseRequest(line)).toThrow("unsupported operation");
  });

  it.each([
    ["absent", '{"op":"resume"}'],
    ["too short", `{"op":"resume","expectedBasePolicySha256":"${"a".repeat(63)}"}`],
    ["not hex", `{"op":"resume","expectedBasePolicySha256":"${"z".repeat(64)}"}`],
    ["not a string", '{"op":"resume","expectedBasePolicySha256":123}'],
  ])("rejects a resume whose digest is %s", (_label, line) => {
    expect(() => parseRequest(line)).toThrow();
  });

  it("ignores extra fields rather than letting them reach the driver", () => {
    const parsed = parseRequest('{"op":"pause","executable":"/bin/sh","argv":["-c","id"]}');
    expect(parsed).toEqual({ op: "pause" });
    expect(parsed).not.toHaveProperty("executable");
    expect(parsed).not.toHaveProperty("argv");
  });
});

describe("asDigest", () => {
  it("brands a digest this process computed", () => {
    expect(asDigest(capabilityDigest("x"))).toBe(capabilityDigest("x"));
  });

  it("refuses anything that is not a sha256", () => {
    expect(() => asDigest("nope")).toThrow();
  });
});
