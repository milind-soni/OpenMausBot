// The native CLI's launch environment, its own sign-in file, and its `--login` Google sign-in, against a fake CLI.
//
// Adapted from pingdotgg/t3code@38067630229, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityAuthSupport.test.ts and
//     apps/server/src/provider/Drivers/AntigravityDriver.test.ts (the
//     environment's SSH_CONNECTION and self-update cases, the code link and
//     the pasted code or page address), on a fake program instead of a stub.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import {
  ANTIGRAVITY_CODE_REDIRECT_URI,
  ANTIGRAVITY_SSH_CONNECTION,
  antigravityLoginResponse,
  antigravityProfileAuthenticated,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
} from "./antigravity-acp.ts";
import { antigravityCliAccessToken } from "./antigravity-account.ts";
import { AntigravityAuthController } from "./antigravity-auth.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";
import { antigravitySignInError } from "./antigravity.ts";

const WINDOWS = process.platform === "win32";
const scratch: string[] = [];
const controllers: AntigravityAuthController[] = [];

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-login-"));
  scratch.push(directory);
  return directory;
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.cancel();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

const LINK = `https://accounts.google.com/o/oauth2/auth?client_id=fixture&redirect_uri=${encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI)}&response_type=code&scope=openid&state=fixture-state`;

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
    expect(cli.tokenPath).toBe(join(cli.directory, "antigravity-acp", "antigravity-oauth-token"));
    const pinned = await prepareAntigravityProfile({
      instanceId: "pinned", baseDir, runtime: pinnedRuntime, baseEnv: { PATH: "/usr/bin", SSH_CONNECTION: "203.0.113.9 52144 10.0.0.2 22" },
    });
    expect(pinned.environment.SSH_CONNECTION).toBeUndefined();
    expect(pinned.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBeUndefined();
    expect(pinned.tokenPath).toBe(join(pinned.directory, "antigravity-acp", "acp_token.json"));
  });

  it("counts an account as signed in on the CLI by the CLI's own file, never by the pinned runtime's", async () => {
    const baseDir = folder();
    const profile = await prepareAntigravityProfile({ instanceId: "moved", baseDir, runtime: cliRuntime("/cli/antigravity") });
    writeFileSync(join(profile.directory, "antigravity-acp", "acp_token.json"), "{\"refresh_token\":\"r\"}");
    expect(await antigravityProfileAuthenticated(profile)).toBe(false);
    writeFileSync(profile.tokenPath, "{\"token\":{}}");
    expect(await antigravityProfileAuthenticated(profile)).toBe(true);
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

describe("the code link and what is pasted back", () => {
  it("takes the `--login` link only with Google's Antigravity page as its redirect", () => {
    expect(parseAntigravityAuthorizationUrl(LINK, "code")).toMatchObject({ redirectUri: ANTIGRAVITY_CODE_REDIRECT_URI, state: "fixture-state" });
    expect(() => parseAntigravityAuthorizationUrl(LINK)).toThrow("invalid Google sign-in URL");
    expect(() => parseAntigravityAuthorizationUrl(LINK.replace(encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI), encodeURIComponent("https://example.com/cb")), "code")).toThrow("invalid Google sign-in URL");
  });

  it("accepts the code or that page's address for this sign-in, and nothing with a line break", () => {
    const pending = { redirectUri: ANTIGRAVITY_CODE_REDIRECT_URI, state: "fixture-state" };
    expect(antigravityLoginResponse(pending, "  4/0Ab-c_d.e~f  ")).toBe("4/0Ab-c_d.e~f");
    expect(antigravityLoginResponse(pending, `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=fixture-state&code=xyz`)).toBe(`${ANTIGRAVITY_CODE_REDIRECT_URI}?state=fixture-state&code=xyz`);
    expect(antigravityLoginResponse(pending, `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=other&code=xyz`)).toBeUndefined();
    expect(antigravityLoginResponse(pending, "https://evil.example/oauth-callback?state=fixture-state&code=xyz")).toBeUndefined();
    expect(antigravityLoginResponse(pending, "code\nmore")).toBeUndefined();
  });
});

describe.skipIf(WINDOWS)("signing in with `agy acp --login`", () => {
  async function started() {
    const fake = fakeCli();
    const profile = await prepareAntigravityProfile({
      instanceId: `login-${scratch.length}`, baseDir: folder(), runtime: cliRuntime(fake.executable),
      baseEnv: { ...process.env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
    });
    let signedIn = 0;
    const controller = new AntigravityAuthController(() => { signedIn += 1; });
    controllers.push(controller);
    const flow = await controller.start(cliRuntime(fake.executable), profile);
    return { fake, profile, controller, flow, signedIn: () => signedIn };
  }

  it("hands over the link it prints, with no display, then finishes with the code pasted back", async () => {
    const { fake, profile, controller, flow, signedIn } = await started();
    expect(flow).toMatchObject({ phase: "waiting", authorizationUrl: LINK, pasteCode: true });
    const launch = JSON.parse(readFileSync(fake.dump, "utf8"));
    expect(launch.argv).toEqual(["acp", "--gemini-dir", profile.directory, "--app-data-dir", "antigravity-acp", "--login"]);
    expect(launch.env.DISPLAY).toBeUndefined();
    expect(launch.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(launch.env.SSH_CONNECTION).toBe(ANTIGRAVITY_SSH_CONNECTION);
    expect(launch.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    // What does not answer this sign-in is refused before anything reaches the CLI.
    await expect(controller.complete(flow.flowId!, "https://evil.example/x?code=good-code")).rejects.toThrow("Paste the code from the Antigravity page");
    expect((await controller.get(flow.flowId!)).phase).toBe("waiting");
    await controller.complete(flow.flowId!, "good-code");
    expect(await controller.get(flow.flowId!)).toMatchObject({ phase: "succeeded" });
    expect(signedIn()).toBe(1);
    expect(await antigravityProfileAuthenticated(profile)).toBe(true);
  }, 30_000);

  it("finishes with the Antigravity page's address pasted instead of the code", async () => {
    const { controller, flow, profile } = await started();
    await controller.complete(flow.flowId!, `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=fixture-state&code=good-code`);
    expect(existsSync(profile.tokenPath)).toBe(true);
  }, 30_000);

  it("fails with a fixed line when the CLI does not accept the code", async () => {
    const { controller, flow, signedIn } = await started();
    await expect(controller.complete(flow.flowId!, "wrong-code")).rejects.toThrow("Google sign-in failed. Start sign-in again.");
    expect(await controller.get(flow.flowId!)).toMatchObject({ phase: "failed" });
    expect(signedIn()).toBe(0);
  }, 30_000);

  it("stops the CLI when the sign-in is cancelled", async () => {
    const { controller, flow } = await started();
    controller.cancel();
    expect(await controller.get(flow.flowId!)).toMatchObject({ phase: "cancelled" });
    await expect(controller.complete(flow.flowId!, "good-code")).rejects.toThrow("no longer active");
  }, 30_000);
});
