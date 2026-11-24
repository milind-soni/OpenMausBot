// fixtures/<version>/ is what those GitHub CLI releases printed on 2026-11-24, run without a terminal in an empty
// config folder (temp paths and addresses replaced). fixtures/constructed/ is built from gh's own format strings
// (pkg/cmd/auth/status/status.go) for the answers a recording cannot give without a real account: a working sign-in.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hostsFileLogin, hostsFileToken, loginFailure, parseDeviceCode, parseGhVersion, parseScopes, parseStatusJson, parseStatusText, tokenFrom, VERIFICATION_URL, versionAtLeast } from "./gh-output.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("GitHub CLI's output", () => {
  it("reads the code and the device page from every recorded release, with or without the clipboard line", () => {
    expect(parseDeviceCode(fixture("2.40.1/login.stderr.txt"))).toEqual({ code: "7E95-AA50", verificationUrl: VERIFICATION_URL });
    expect(parseDeviceCode(fixture("2.102.0/login.stderr.txt"))).toEqual({ code: "6C49-C9EB", verificationUrl: VERIFICATION_URL });
    expect(parseDeviceCode(fixture("2.102.0/login-clipboard.stderr.txt"))).toEqual({ code: "0DE6-7337", verificationUrl: VERIFICATION_URL });
    expect(parseDeviceCode(fixture("2.103.3/login.stderr.txt"))).toEqual({ code: "B1A5-0221", verificationUrl: VERIFICATION_URL });
    // Colour codes and Windows line ends change nothing.
    expect(parseDeviceCode("\u001b[33m!\u001b[0m First copy your one-time code: \u001b[1mABCD-1234\u001b[0m\r\nOpen this URL to continue in your web browser: https://github.com/login/device\r\n")?.code).toBe("ABCD-1234");
  });

  it("waits for both lines, and never takes another site as the place to type the code", () => {
    expect(parseDeviceCode("! First copy your one-time code: ABCD-1234\n")).toBeNull();
    expect(parseDeviceCode("Open this URL to continue in your web browser: https://github.com/login/device")).toBeNull();
    expect(parseDeviceCode("! First copy your one-time code: ABCD-1234\nOpen this URL: https://github.com.evil.example/login/device")).toBeNull();
    expect(parseDeviceCode("! First copy your one-time code: ABCD-1234\nOpen this URL: http://github.com/login/device")).toBeNull();
    expect(parseDeviceCode("! First copy your one-time code: ABCD-1234\nOpen this URL: https://evil.example/?u=https://github.com/login/device")).toBeNull();
  });

  it("reads versions, and which releases take the sign-in's flags", () => {
    expect(parseGhVersion(fixture("2.40.1/version.stdout.txt"))).toEqual([2, 40, 1]);
    expect(parseGhVersion(fixture("2.102.0/version.stdout.txt"))).toEqual([2, 102, 0]);
    expect(parseGhVersion(fixture("2.103.3/version.stdout.txt"))).toEqual([2, 103, 3]);
    expect(parseGhVersion("git version 2.46.0")).toBeNull();
    expect(versionAtLeast([2, 102, 0], [2, 102, 0])).toBe(true);
    expect(versionAtLeast([2, 40, 1], [2, 102, 0])).toBe(false);
    expect(versionAtLeast([3, 0, 0], [2, 102, 0])).toBe(true);
    expect(versionAtLeast(null, [2, 102, 0])).toBe(false);
    // 2.40.1 refuses the clipboard flag the floor exists for.
    expect(fixture("2.40.1/login-clipboard-flag.stderr.txt")).toContain("unknown flag: --clipboard");
  });

  it("counts a token as refused only on GitHub's own 401, never on no network", () => {
    for (const version of ["2.102.0", "2.103.3"]) {
      expect(parseStatusJson(fixture(`${version}/status-json-invalid.stdout.txt`))).toEqual({ state: "invalid", login: "octo-fixture", scopes: [], error: "HTTP 401: Bad credentials (https://api.github.com/)" });
    }
    // The same `error` state with the network cut (HTTPS_PROXY to a closed port): unknown, not refused.
    expect(parseStatusJson(fixture("2.103.3/status-json-offline.stdout.txt"))).toMatchObject({ state: "unknown", login: "octo-fixture" });
    // The text reads the same for both (2.40.1 on stdout, 2.103.3 on stderr), so it is never taken as a refusal.
    for (const name of ["2.102.0/status-invalid.stderr.txt", "2.103.3/status-invalid.stderr.txt", "2.40.1/status-invalid.stdout.txt", "2.103.3/status-offline.stderr.txt", "2.40.1/status-offline.stdout.txt"]) {
      expect(parseStatusText(fixture(name)), name).toMatchObject({ state: "unknown", login: "octo-fixture" });
    }
    expect(fixture("2.103.3/status-offline.stderr.txt")).toBe(fixture("2.103.3/status-invalid.stderr.txt"));
    expect(parseStatusText("github.com\n  X Token for github.com account octo-fixture (keyring) has expired\n")).toMatchObject({ state: "invalid", login: "octo-fixture" });
    // 2.40.1 has no --json: its answer is no JSON, so the text is read instead.
    expect(parseStatusJson(fixture("2.40.1/status-json.stderr.txt"))).toBeNull();
  });

  it("reads signed out from every release", () => {
    expect(parseStatusJson(fixture("2.102.0/status-json-signedout.stdout.txt"))).toBe("signed-out");
    expect(parseStatusText(fixture("2.40.1/status-signedout.stderr.txt"))).toBe("signed-out");
    expect(parseStatusText(fixture("2.103.3/status-signedout.stderr.txt"))).toBe("signed-out");
  });

  it("reads a working sign-in, its login and scopes, in each format", () => {
    const want = { state: "success", login: "octo-fixture", scopes: ["gist", "read:org", "repo"] };
    expect(parseStatusJson(fixture("constructed/status-json-success.stdout.txt"))).toEqual(want);
    expect(parseStatusText(fixture("constructed/status-text-success.stderr.txt"))).toEqual(want);
    expect(parseStatusText(fixture("constructed/status-text-success-before-2.40.stdout.txt"))).toEqual(want);
    expect(parseScopes("repo, read:org, gist, <script>")).toEqual(["gist", "read:org", "repo"]);
  });

  it("answers null for anything it cannot recognise", () => {
    for (const text of ["", "{", "{\"hosts\":[]}", "{\"hosts\":{\"github.com\":\"x\"}}", "something else entirely"]) {
      expect(parseStatusJson(text)).toBeNull();
    }
    expect(parseStatusText("something else entirely")).toBeNull();
    expect(parseStatusJson("{\"hosts\":{\"github.com\":[{\"state\":\"success\",\"active\":true,\"login\":\"bad login;rm\"}]}}")).toMatchObject({ state: "success", login: null });
  });

  it("says why a login ended in one plain line", () => {
    expect(loginFailure(fixture("2.103.3/login-network-failure.stderr.txt"))).toEqual({ outcome: "failed", reason: "GitHub could not be reached from this server. Check its network connection, then try again." });
    // gh 2.103.3 left waiting: it gave up by itself after 899 s with this line and exit code 1.
    expect(loginFailure(fixture("2.103.3/login-expired.stderr.txt"))).toEqual({ outcome: "expired", reason: "The code expired before it was entered on GitHub." });
    expect(loginFailure("failed to authenticate via web browser: access_denied")).toMatchObject({ outcome: "failed", reason: "The sign-in was turned down on GitHub." });
    const other = loginFailure(`${fixture("2.103.3/login.stderr.txt")}something odd happened\n`);
    expect(other).toEqual({ outcome: "failed", reason: "GitHub CLI stopped: something odd happened" });
  });

  it("reads the login from gh's config file, and a token only when it looks like one", () => {
    expect(hostsFileLogin(fixture("constructed/hosts.yml.txt"))).toBe("octo-fixture");
    const saved = ["gho", "y".repeat(36)].join("_");
    expect(hostsFileToken(fixture("constructed/hosts.yml.txt").replaceAll("TOKEN", saved))).toBe(saved);
    expect(hostsFileToken("gitlab.com:\n    oauth_token: x\n")).toBeNull();
    expect(hostsFileLogin("gitlab.com:\n    user: someone\n")).toBeNull();
    const token = ["gho", "x".repeat(36)].join("_");
    expect(tokenFrom(`${token}\n`)).toBe(token);
    expect(tokenFrom("no oauth token found for github.com")).toBeNull();
    expect(tokenFrom("")).toBeNull();
  });
});
