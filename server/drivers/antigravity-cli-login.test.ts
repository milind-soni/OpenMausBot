// The native CLI's launch environment, its own sign-in file, and the environment of its `--login` Google sign-in, against
// a fake CLI.
//
// Adapted from pingdotgg/t3code@38067630229, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityAuthSupport.test.ts and
//     apps/server/src/provider/Drivers/AntigravityDriver.test.ts (the
//     environment's SSH_CONNECTION and self-update cases), on a fake program
//     instead of a stub.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { ANTIGRAVITY_SSH_CONNECTION, prepareAntigravityProfile } from "./antigravity-acp.ts";
import { antigravityCliAccessToken } from "./antigravity-account.ts";
import { ANTIGRAVITY_LOGIN_REDIRECT, AntigravityCliLogin } from "./antigravity-native-login.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";
import { antigravitySignInError } from "./antigravity.ts";

const WINDOWS = process.platform === "win32";
const scratch: string[] = [];
const logins: AntigravityCliLogin[] = [];

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-login-"));
  scratch.push(directory);
  return directory;
}

afterEach(async () => {
  for (const login of logins.splice(0)) await login.cancel();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

const LINK = `https://accounts.google.com/o/oauth2/auth?client_id=fixture&redirect_uri=${encodeURIComponent(ANTIGRAVITY_LOGIN_REDIRECT)}&response_type=code&scope=openid&state=fixture-state`;

/** A program named `antigravity` that, with `--login`, prints a Google link among other lines, reads one line, and on
 * `good-code` (or the page's address carrying it) writes the CLI's sign-in file and exits 0. */
function fakeCli(): { executable: string; dump: string } {
  const directory = folder();
  const script = join(directory, "fake-login.mjs"), dump = join(directory, "dump.json");
  writeFileSync(script, `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv, env: process.env }));
const geminiDir = argv[argv.indexOf("--gemini-dir") + 1];
process.stdout.write("Signing in to Antigravity.\\nOpen this link in a browser:\\n" + ${JSON.stringify(LINK)} + "\\nPaste the code here: ");
createInterface({ input: process.stdin }).once("line", (line) => {
  const ok = line === "good-code" || line.includes("code=good-code");
  if (ok) {
    mkdirSync(join(geminiDir, "antigravity-acp"), { recursive: true });
    writeFileSync(join(geminiDir, "antigravity-acp", "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "a", expiry: "2099-01-01T00:00:00Z" } }));
  }
  process.exit(ok ? 0 : 1);
});
`);
  const executable = join(directory, "antigravity");
  writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(executable, 0o755);
  return { executable, dump };
}

const cliRuntime = (executablePath: string): AntigravityRuntime => ({ executablePath, harnessPath: null, source: "managed", version: "1.5.15" });
const pinnedRuntime: AntigravityRuntime = { executablePath: "/r/agy_acp_server.par", harnessPath: "/r/localharness_external", source: "managed", version: "1.4.3" };

describe("the native CLI's environment and sign-in file", () => {
  it("turns its self-update off and sets the SSH_CONNECTION that keeps the sign-in in the profile, a fixed value even over SSH", async () => {
    const baseDir = folder();
    const cli = await prepareAntigravityProfile({
      instanceId: "cli", baseDir, runtime: cliRuntime("/cli/antigravity"),
      baseEnv: { PATH: "/usr/bin", SSH_CONNECTION: "203.0.113.9 52144 10.0.0.2 22", AGY_CLI_DISABLE_AUTO_UPDATE: "0" },
    });
    expect(cli.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(cli.environment.SSH_CONNECTION).toBe(ANTIGRAVITY_SSH_CONNECTION);
    // `tokenPath` is the pinned runtime's file on either runtime: the CLI's sign-in is asked of the CLI itself.
    expect(cli.tokenPath).toBe(join(cli.directory, "antigravity-acp", "acp_token.json"));
    const pinned = await prepareAntigravityProfile({
      instanceId: "pinned", baseDir, runtime: pinnedRuntime, baseEnv: { PATH: "/usr/bin", SSH_CONNECTION: "203.0.113.9 52144 10.0.0.2 22" },
    });
    // The pinned runtime gets the environment as before: the server's own value passes, nothing is set.
    expect(pinned.environment.SSH_CONNECTION).toBe("203.0.113.9 52144 10.0.0.2 22");
    expect(pinned.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBeUndefined();
    expect(pinned.tokenPath).toBe(join(pinned.directory, "antigravity-acp", "acp_token.json"));
  });

  it("reads the CLI file's access token only while it has more than a minute left", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    expect(antigravityCliAccessToken({ token: { access_token: "a", expiry: "2026-11-23T12:05:00Z" } }, now)).toEqual({ accessToken: "a", expiresAt: Date.parse("2026-11-23T12:05:00Z") });
    expect(antigravityCliAccessToken({ token: { access_token: "a", expiry: "2026-11-23T12:00:30Z" } }, now)).toBeNull();
    expect(antigravityCliAccessToken({ client_id: "c", refresh_token: "r" }, now)).toBeNull();
  });

  it("takes the CLI's no-browser answer to authenticate as a sign-in request", () => {
    expect(antigravitySignInError({ code: -32603, message: "No browser is available here. Run agy --login." })).toBe(true);
    expect(antigravitySignInError({ code: -32603, message: "Internal error" })).toBe(false);
  });
});

describe.skipIf(WINDOWS)("signing in with `antigravity acp --login`", () => {
  it("starts the CLI with no display, the fixed SSH_CONNECTION and no self-update, so it prints its link and keeps the sign-in in the profile", async () => {
    const fake = fakeCli();
    const profile = await prepareAntigravityProfile({
      instanceId: "login", baseDir: folder(), runtime: cliRuntime(fake.executable),
      baseEnv: { ...process.env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", SSH_CONNECTION: "203.0.113.9 52144 10.0.0.2 22" },
    });
    let signedIn = 0;
    const login = new AntigravityCliLogin({ signedIn: () => { signedIn += 1; } });
    logins.push(login);
    const flow = await login.start(cliRuntime(fake.executable), profile);
    expect(flow).toMatchObject({ phase: "waiting", authorizationUrl: LINK, kind: "pasted-code" });
    const launch = JSON.parse(readFileSync(fake.dump, "utf8"));
    expect(launch.argv).toEqual(["acp", "--login", "--gemini-dir", profile.directory, "--app-data-dir", "antigravity-acp"]);
    expect(launch.env.DISPLAY).toBeUndefined();
    expect(launch.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(launch.env.SSH_CONNECTION).toBe(ANTIGRAVITY_SSH_CONNECTION);
    expect(launch.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    await login.complete(flow.flowId!, `${ANTIGRAVITY_LOGIN_REDIRECT}?state=fixture-state&code=good-code`);
    expect(signedIn).toBe(1);
    expect(existsSync(join(profile.directory, "antigravity-acp", "antigravity-oauth-token"))).toBe(true);
  }, 30_000);
});
