import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { appArmorProfile, BrowserHostError, diagnoseLaunchFailure, LIBRARIES_COMMAND, missingLibraries, SANDBOX_STEPS_URL, sandboxBlocked, sandboxDisabled, USERNS_RESTRICTION } from "./host-setup.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

describe("host setup", () => {
  it("pins the AppArmor exemption to one root-owned executable", () => {
    const profile = appArmorProfile("/opt/OpenMausBot/resources/chrome/chrome");
    expect(profile).toContain("profile openmausbot-chrome /opt/OpenMausBot/resources/chrome/chrome flags=(unconfined)");
    expect(profile).toContain("userns,");
    for (const path of ["/opt/**/chrome", "/home/a/chrome", "relative/chrome", "/opt/a b/chrome"]) expect(() => appArmorProfile(path)).toThrow();
  });

  it("names the sandbox when Chrome says it has none, and never turns it off by itself", async () => {
    const diagnosis = await diagnoseLaunchFailure({ executable: "/opt/chrome", output: "[0101/000000.000:FATAL:zygote_host_impl_linux.cc] No usable sandbox! ...", platform: "darwin" });
    expect(diagnosis).toBeInstanceOf(BrowserHostError);
    expect(diagnosis?.kind).toBe("sandbox");
    expect(diagnosis?.message).toContain(SANDBOX_STEPS_URL);
    expect(diagnosis?.message).not.toMatch(/browser setup/);
    // The linked steps exist, and the viewer offers the same link and command.
    expect(readFileSync(new URL("../../../docs/deploy-vps.md", import.meta.url), "utf8")).toMatch(/^### Ubuntu 24\.04 browser sandbox$/m);
    expect(SANDBOX_STEPS_URL.endsWith("/docs/deploy-vps.md#ubuntu-2404-browser-sandbox")).toBe(true);
    const viewer = readFileSync(new URL("../../../src/lib/browser-stream-client.ts", import.meta.url), "utf8");
    expect(viewer).toContain(`"${SANDBOX_STEPS_URL}"`);
    expect(viewer).toContain(`"${LIBRARIES_COMMAND}"`);
    expect(LIBRARIES_COMMAND).toBe("sudo openmausbot browser install --with-deps");
    expect(new BrowserHostError("libraries", ["libnss3.so"]).message).toContain(LIBRARIES_COMMAND);
    expect(await diagnoseLaunchFailure({ executable: "/opt/chrome", output: "something else", platform: "darwin" })).toBeNull();
    expect(sandboxDisabled({})).toBe(false);
    expect(sandboxDisabled({ OMB_BROWSER_SANDBOX: "0" })).toBe(true);
  });

  it.skipIf(process.platform === "win32")("asks the browser's own loader which libraries are missing, in the environment the browser launched with", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-host-setup-test-"));
    folders.push(dir);
    const chrome = join(dir, "chrome");
    writeFileSync(chrome, `#!/bin/sh\nprintf '%s' "$HOME" > '${dir}/home'\necho "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file" >&2\nexit 127\n`, { mode: 0o755 });
    const env = { PATH: "/usr/bin:/bin", HOME: "/home/someone" };
    expect(await missingLibraries(chrome, env)).toEqual(["libnss3.so"]);
    expect(readFileSync(join(dir, "home"), "utf8")).toBe("/home/someone");
    expect(await diagnoseLaunchFailure({ executable: chrome, output: "", platform: "linux", env })).toMatchObject({ kind: "libraries", libraries: ["libnss3.so"] });
  });

  it("sees a blocked sandbox only where user namespaces are restricted and no profile is installed", () => {
    const read = (path: string) => (path === USERNS_RESTRICTION ? "1\n" : "");
    expect(sandboxBlocked({ platform: "linux", read, exists: () => false })).toBe(true);
    expect(sandboxBlocked({ platform: "linux", read, exists: () => true })).toBe(false);
    expect(sandboxBlocked({ platform: "linux", read: () => "0", exists: () => false })).toBe(false);
    expect(sandboxBlocked({ platform: "darwin", read, exists: () => false })).toBe(false);
  });
});
