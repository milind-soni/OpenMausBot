// Every process here is the offline fake kimi in a disposable HOME: no real Kimi, no Moonshot call, no credentials.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceSignInLink, deviceSignInPrompt, isDeviceSignInCode } from "../../../shared/device-sign-in.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { serverInstallFor } from "../../engine-install.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { DeviceAuthController } from "../device-auth.ts";
import { KIMI_DEVICE_SIGN_IN, KimiAgentDriver } from "./kimi.ts";

const FAKE_KIMI = fileURLToPath(new URL("../../testing/fake-kimi-login-cli.ts", import.meta.url));
const CODE = "QKXP-7M4D";
const PAGE = `https://www.kimi.com/code/authorize_device?user_code=${CODE}`;

describe("Kimi on a server without a terminal", () => {
  it("installs from Settings with Moonshot's npm package when the server has npm", () => {
    expect(serverInstallFor(KimiAgentDriver.install, true)).toEqual({ package: "@moonshot-ai/kimi-code" });
    expect(serverInstallFor(KimiAgentDriver.install, false)).toBeNull();
  });

  it("keeps Moonshot's own installer as the command for a terminal", () => {
    expect(KimiAgentDriver.install?.command?.linux).toBe("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash");
  });
});

describe("Kimi device prompt", () => {
  // kimi-code 2.4.1's own stderr lines (src/cli/sub/login-flow.ts).
  const printed = (page: string, code = CODE) => [
    "",
    `Opening browser for Kimi device login: ${page}`,
    `If the browser did not open, paste the URL above and enter code: ${code}`,
    "Code expires in 600s.",
    "Waiting for authorization to complete…",
    "",
  ].join("\n");

  it("reads Moonshot's page and the code from Kimi's labelled lines", () => {
    expect(deviceSignInPrompt("kimi", printed(PAGE))).toEqual({ authorizationUrl: PAGE, userCode: CODE });
    const global = `https://www.kimi.ai/code/authorize_device?user_code=${CODE}`;
    expect(deviceSignInPrompt("kimi", printed(global))).toEqual({ authorizationUrl: global, userCode: CODE });
    expect(deviceSignInPrompt("kimi", printed("https://auth.kimi.com/device"))).toEqual({ authorizationUrl: "https://auth.kimi.com/device", userCode: CODE });
  });

  it("waits for the code line to arrive whole", () => {
    expect(deviceSignInPrompt("kimi", `\nOpening browser for Kimi device login: ${PAGE}\nIf the browser did not open, paste the URL above and enter code: QKXP-7`)).toBeNull();
  });

  it("follows the new code Kimi prints once the first expires", () => {
    const renewed = "https://www.kimi.com/code/authorize_device?user_code=RW7N-2KQ9";
    expect(deviceSignInPrompt("kimi", printed(PAGE) + printed(renewed, "RW7N-2KQ9"))).toEqual({ authorizationUrl: renewed, userCode: "RW7N-2KQ9" });
    expect(deviceSignInPrompt("kimi", `${printed(PAGE)}\nOpening browser for Kimi device login: ${renewed}\n`)).toEqual({ authorizationUrl: PAGE, userCode: CODE });
  });

  it("keeps only the code in the page's query, and only when it is that same code", () => {
    expect(deviceSignInPrompt("kimi", printed(`${PAGE}&state=secret-token`))).toEqual({ authorizationUrl: PAGE, userCode: CODE });
    expect(deviceSignInPrompt("kimi", printed("https://www.kimi.com/code/authorize_device?user_code=ZZZZ-ZZZZ"))).toBeNull();
  });

  it.each([
    "http://www.kimi.com/code/authorize_device",
    "https://kimi.com.evil.test/device",
    "https://evilkimi.com/device",
    "https://user@www.kimi.com/device",
    "https://www.kimi.com:8443/device",
    "https://www.kimi.com/device#token",
    "https://accounts.x.ai/device",
  ])("never turns another page into a sign-in link: %s", (page) => {
    expect(deviceSignInPrompt("kimi", printed(page))).toBeNull();
    expect(deviceSignInLink("kimi", page, CODE)).toBeNull();
  });

  it("knows a code from other output", () => {
    expect(isDeviceSignInCode("kimi", CODE)).toBe(true);
    expect(isDeviceSignInCode("kimi", "KLXE-NNPJ")).toBe(true);
    for (const line of ["Code expires in 600s.", "Waiting", "Opening", "klxe-nnpj", "AB", ""]) expect(isDeviceSignInCode("kimi", line)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Kimi Code sign-in with a device code", () => {
  let home: string;
  let instances: ProviderInstance[];
  const kimi = async (mode: string, environment: Record<string, string> = {}) => {
    const instance = await KimiAgentDriver.create({
      instanceId: "kimi", displayName: "Kimi", enabled: true,
      config: KimiAgentDriver.decodeConfig({ cli: FAKE_KIMI }),
      // A stray Moonshot key must not reach the subscription login.
      environment: { HOME: home, USERPROFILE: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_KIMI_MODE: mode, MOONSHOT_API_KEY: "sk-fixture-must-not-leak", ...environment },
    });
    instances.push(instance);
    return instance;
  };
  const calls = () => readFileSync(join(home, "fake-kimi-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const pid = () => Number(readFileSync(join(home, "fake-kimi-login.pid"), "utf8"));
  const alive = (target: number) => { try { process.kill(target, 0); return true; } catch { return false; } };
  const credential = (root = join(home, ".kimi-code")) => join(root, "credentials", "kimi-code.json");

  beforeEach(() => {
    chmodSync(FAKE_KIMI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-kimi-device-"));
    instances = [];
  });
  afterEach(async () => {
    await Promise.all(instances.map((instance) => instance.dispose()));
    await removeTempDir(home);
  });

  it("shows Moonshot's page and code, then confirms the sign-in the driver's own check reads", async () => {
    const instance = await kimi("success");
    expect((await instance.snapshot()).authenticated).toBe(false);
    const start = await instance.startAuthentication!();
    expect(start).toMatchObject({ phase: "waiting", authorizationUrl: PAGE, userCode: CODE, flowId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await expect.poll(() => instance.getAuthentication!(start.flowId!), { timeout: 5_000 })
      .toEqual({ phase: "succeeded", flowId: start.flowId, authorizationUrl: null, expiresAt: null });
    expect(existsSync(credential())).toBe(true);
    expect((await instance.snapshot()).authenticated).toBe(true);
    const logins = calls().filter((call) => call.args[0] === "login");
    expect(logins).toEqual([{ args: ["login"], home, kimiHome: join(home, ".kimi-code"), moonshotKey: null }]);
  });

  it("signs in to the instance's own KIMI_CODE_HOME, and reads it there", async () => {
    const kimiHome = join(home, "work-kimi");
    const instance = await kimi("success", { KIMI_CODE_HOME: kimiHome });
    const start = await instance.startAuthentication!();
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    expect(existsSync(credential(kimiHome))).toBe(true);
    expect(existsSync(credential())).toBe(false);
    expect((await instance.snapshot()).authenticated).toBe(true);
  });

  it("confirms a kimi.ai sign-in, which Kimi saves under its own token name", async () => {
    const instance = await kimi("global");
    const start = await instance.startAuthentication!();
    expect(start).toMatchObject({ authorizationUrl: `https://www.kimi.ai/code/authorize_device?user_code=${CODE}`, userCode: CODE });
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    expect(existsSync(credential())).toBe(false);
    expect((await instance.snapshot()).authenticated).toBe(true);
  });

  it("does not count another file in Kimi's credentials folder as a sign-in", async () => {
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(join(home, ".kimi-code", "credentials", "kimi-code-env-0123456789abcdef.json.tmp.1.x"), "{}");
    writeFileSync(join(home, ".kimi-code", "credentials", "other-provider.json"), "{}");
    expect((await (await kimi("waiting")).snapshot()).authenticated).toBe(false);
  });

  it("does not count a sign-in Kimi revoked, which it keeps with empty tokens", async () => {
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(credential(), JSON.stringify({ access_token: "", refresh_token: "", expires_at: 0, scope: "", token_type: "", expires_in: 0 }));
    expect((await (await kimi("waiting")).snapshot()).authenticated).toBe(false);
  });

  it("shows the new code Kimi prints once the first expires", async () => {
    const instance = await kimi("renew");
    const start = await instance.startAuthentication!();
    expect(start).toMatchObject({ authorizationUrl: PAGE, userCode: CODE });
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).userCode, { timeout: 5_000 }).toBe("RW7N-2KQ9");
    expect(await instance.getAuthentication!(start.flowId!)).toMatchObject({
      phase: "waiting", authorizationUrl: "https://www.kimi.com/code/authorize_device?user_code=RW7N-2KQ9",
    });
  });

  it("shows a page without the CLI's other query values", async () => {
    const instance = await kimi("extra");
    const start = await instance.startAuthentication!();
    expect(start).toMatchObject({ authorizationUrl: PAGE, userCode: CODE });
    expect(JSON.stringify(start)).not.toContain("secret-token");
  });

  it("cancels: the login process stops and the code is gone", async () => {
    const instance = await kimi("ignore-term");
    const start = await instance.startAuthentication!();
    expect(alive(pid())).toBe(true);
    await instance.cancelAuthentication!();
    expect(alive(pid())).toBe(false);
    const status = await instance.getAuthentication!(start.flowId!);
    expect(status).toMatchObject({ phase: "cancelled", message: "Kimi Code sign-in cancelled.", authorizationUrl: null });
    expect(status.userCode).toBeUndefined();
    expect(existsSync(credential())).toBe(false);
  });

  it("does not show a page on another host, and gives up waiting for one", async () => {
    const controller = new DeviceAuthController(KIMI_DEVICE_SIGN_IN, {
      cli: FAKE_KIMI, startupTimeoutMs: 1_000, terminateTimeoutMs: 50,
      environment: () => ({ ...process.env, HOME: home, OMB_DEVICE_AUTH_FIXTURE: "1", FAKE_KIMI_MODE: "evil" }),
    });
    try {
      await expect(controller.start()).rejects.toThrow("Kimi did not provide a sign-in code in time");
      await controller.cancel();
      expect(alive(pid())).toBe(false);
    } finally { await controller.dispose(); }
  });

  it.each([
    ["expired", "The Kimi sign-in code expired. Start sign-in again for a new code."],
    ["denied", "Kimi sign-in was declined in the browser. Start sign-in again to try once more."],
    ["crash", "Kimi sign-in did not finish. Check the server's connection, then try again."],
    ["no-credential", "Kimi finished sign-in but did not confirm a Kimi Code account. Refresh Settings and try again."],
  ])("ends a %s sign-in with one plain message and none of the CLI's words", async (mode, message) => {
    const instance = await kimi(mode);
    const start = await instance.startAuthentication!();
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("failed");
    const status = await instance.getAuthentication!(start.flowId!);
    expect(status.message).toBe(message);
    expect(JSON.stringify(status)).not.toContain("secret-token");
    expect((await instance.snapshot()).authenticated).toBe(false);
  });

  it("says plainly when Kimi is missing on the server", async () => {
    const missing = await KimiAgentDriver.create({
      instanceId: "kimi-missing", displayName: "Kimi", enabled: true,
      config: KimiAgentDriver.decodeConfig({ cli: join(home, "no-such-kimi") }),
      environment: { HOME: home, OMB_DEVICE_AUTH_FIXTURE: "1" },
    });
    instances.push(missing);
    await expect(missing.startAuthentication!()).rejects.toThrow("Kimi is not installed on this server.");
  });

  it("approves through the reusable fixture only once its local marker exists", async () => {
    const instance = await kimi("approve");
    const start = await instance.startAuthentication!();
    expect((await instance.getAuthentication!(start.flowId!)).phase).toBe("waiting");
    writeFileSync(join(home, ".omb-fake-kimi-approved"), "approve fixture only\n");
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
  });
});
