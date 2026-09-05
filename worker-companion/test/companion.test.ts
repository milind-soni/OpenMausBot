import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { capabilityDigest, parkedCapability } from "../src/capability.ts";
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

  it("grants only the macOS non-prompting health tool while parked", () => {
    expect(parkedCapability("darwin")).toContain("- check_permissions");
    expect(parkedCapability("darwin")).not.toContain("- click");
    expect(parkedCapability("win32")).toContain("- check_permissions");
    expect(parkedCapability("win32")).not.toContain("- click");
  });

  it("uses lifetimes accepted by CUA Driver 0.20.0", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(parkedCapability(platform)).toContain("expires_after: 24h");
      expect(parkedCapability(platform)).toContain("idle_timeout: 24h");
      expect(parkedCapability(platform)).not.toContain("8760h");
    }
  });

  it("digests the exact bytes it is given", () => {
    // sha256 of the empty string — proves no trimming or normalisation.
    expect(capabilityDigest("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
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
  ])("rejects %s", (_label, line) => {
    expect(() => parseRequest(line)).toThrow("unsupported operation");
  });

  // The task operations landed with the server-side task layer. What still has
  // to hold is the shape of their vocabulary: an id, a digest, an instant, a
  // command id — and nothing that could name a program or a path.
  it.each([
    ["run with no digest", '{"op":"run","taskId":"t","commandId":"c"}'],
    ["validate with a short digest", `{"op":"validate","taskId":"t","manifestSha256":"${"a".repeat(63)}"}`],
    ["reset with no task id", `{"op":"reset","expectedBasePolicySha256":"${"a".repeat(64)}"}`],
    ["activate with no issuing instant", `{"op":"activate","taskId":"t","manifestSha256":"${"a".repeat(64)}","expectedCapabilitySha256":"${"b".repeat(64)}"}`],
    ["a task id that is a path", `{"op":"validate","taskId":"../etc","manifestSha256":"${"a".repeat(64)}"}`],
  ])("rejects %s", (_label, line) => {
    expect(() => parseRequest(line)).toThrow();
  });

  it("accepts a well-formed run", () => {
    const request = parseRequest(`{"op":"run","taskId":"task-1","manifestSha256":"${"a".repeat(64)}","commandId":"build"}`);
    expect(request.op).toBe("run");
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

describe("stdio process boundary", () => {
  it("rejects an oversized request before an unterminated line can accumulate", async () => {
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const child = spawn(process.execPath, ["--experimental-strip-types", entry, "stdio"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stdin.end(Buffer.alloc(1024 * 1024 + 1, 0x61));
    const [code] = await once(child, "close") as [number | null];
    expect(code).toBe(1);
    expect(JSON.parse(stdout.trim())).toEqual({ ok: false, error: "request too large" });
  }, 10_000);
});

describe("asDigest", () => {
  it("brands a digest this process computed", () => {
    expect(asDigest(capabilityDigest("x"))).toBe(capabilityDigest("x"));
  });

  it("refuses anything that is not a sha256", () => {
    expect(() => asDigest("nope")).toThrow();
  });
});
