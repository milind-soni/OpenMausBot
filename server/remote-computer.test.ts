import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  boxExtensionPolicyCommand,
  enabledStoreExtensionIds,
  ensureRemoteCuaCommand,
  isolatedRemoteCommand,
  REMOTE_CUA_EXECUTABLE,
  REMOTE_CUA_SOCKET,
  REMOTE_CUA_VERSION,
  remoteComputerBootstrapCommand,
  REMOTE_EXTENSION_POLICY_PATHS,
  semanticBrowserCommand,
} from "./remote-computer.ts";

describe("remote Cua computer setup", () => {
  it("installs one exact checksummed 0.20.0 driver and disables telemetry", () => {
    const command = remoteComputerBootstrapCommand("Test Bot");
    expect(REMOTE_CUA_VERSION).toBe("0.20.0");
    expect(command).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl");
    expect(command).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl");
    expect(command).toContain("f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961");
    expect(command).toContain("48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77");
    expect(command).toContain(`test "$(${REMOTE_CUA_EXECUTABLE} --version)" = "cua-driver 0.20.0"`);
    expect(command).toContain("sha256sum -c -");
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).not.toContain("uv pip install");
    expect(command).not.toContain("cua-computer-server");
    expect(command).not.toContain("--port 8000");
    if (process.platform !== "win32") {
      expect(spawnSync("/bin/bash", ["-n"], { input: command }).status).toBe(0);
    }
  });

  it("reattaches the private daemon after resume without opening a port", () => {
    const command = ensureRemoteCuaCommand();
    expect(command).toContain(`status --socket ${REMOTE_CUA_SOCKET}`);
    expect(command).toContain(`serve --socket ${REMOTE_CUA_SOCKET} --permission-mode standard`);
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).not.toMatch(/--host|--port/);
  });

  it("encodes semantic browser input instead of interpolating it into shell", () => {
    const command = semanticBrowserCommand("fill", { ref: "b7", text: "don't expand $HOME" });
    expect(command).toContain("openmausbot-cdp.mjs fill");
    expect(command).not.toContain("don't expand");
    expect(command).not.toContain("$HOME");
  });

  it("encodes a bot display name before composing the tmux shell", () => {
    const botName = "$(touch /tmp/openmaus-pwned) `id` ' \\\"";
    const command = remoteComputerBootstrapCommand(botName);
    const encodedBanner = Buffer.from(`  ▦ ${botName}'s computer — OpenMausBot`).toString("base64");

    expect(command).toContain(encodedBanner);
    expect(command).not.toContain("touch /tmp/openmaus-pwned");
    expect(command).not.toContain("`id`");
    if (process.platform !== "win32") {
      expect(spawnSync("/bin/bash", ["-n"], { input: command }).status).toBe(0);
    }
  });

  it("builds a clean remote shell environment without interpolating the command", () => {
    const command = isolatedRemoteCommand(`printf '%s' "$BOX_TOKEN"`);
    expect(command).toContain('exec env -i HOME="$HOME"');
    expect(command).toContain("/bin/bash -c");
    if (process.platform !== "win32") {
      const result = spawnSync("/bin/bash", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, BOX_TOKEN: "must-not-leak" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});


describe("box browser extensions", () => {
  const STORE_A = "a".repeat(32);
  const STORE_B = "b".repeat(32);

  const dataDirWith = (records: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "omb-box-ext-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "browser-extensions.json"), JSON.stringify({ version: 1, extensions: records }));
    return dir;
  };

  it("reads only enabled Web Store ids from the state file", () => {
    const dir = dataDirWith([
      { id: STORE_B, enabled: true },
      { id: STORE_A, enabled: true },
      { id: "c".repeat(32), enabled: false },
      // a local install has no store id, so real Chrome cannot be told to fetch it
      { id: "local-0123456789ab", enabled: true },
      { id: "../../etc", enabled: true },
      { id: STORE_A, enabled: true },
    ]);
    try {
      expect(enabledStoreExtensionIds(dir)).toEqual([STORE_A, STORE_B]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing or corrupt state file as no extensions", () => {
    expect(enabledStoreExtensionIds(join(tmpdir(), "omb-box-ext-nope"))).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "omb-box-ext-"));
    writeFileSync(join(dir, "browser-extensions.json"), "{oops");
    try {
      expect(enabledStoreExtensionIds(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a managed policy that force-installs the enabled ids from the store", () => {
    const command = boxExtensionPolicyCommand([STORE_A]);
    const policy = JSON.parse(
      Buffer.from(/printf %s '([A-Za-z0-9+/=]+)'/.exec(command)![1]!, "base64").toString("utf8"),
    );
    expect(policy).toEqual({
      ExtensionInstallForcelist: [`${STORE_A};https://clients2.google.com/service/update2/crx`],
    });
    for (const path of REMOTE_EXTENSION_POLICY_PATHS) expect(command).toContain(`sudo tee '${path}'`);
    expect(command).toContain("sudo mkdir -p '/etc/opt/chrome/policies/managed' '/etc/chromium/policies/managed'");
  });

  it("always writes the list, so an empty one removes what was force-installed", () => {
    // Chrome uninstalls a force-installed extension when its id leaves the
    // list; that is what makes disable in Settings mean something on the box.
    const command = boxExtensionPolicyCommand([]);
    const policy = JSON.parse(
      Buffer.from(/printf %s '([A-Za-z0-9+/=]+)'/.exec(command)![1]!, "base64").toString("utf8"),
    );
    expect(policy).toEqual({ ExtensionInstallForcelist: [] });
  });

  it("never lets a non-store id into the policy", () => {
    const command = boxExtensionPolicyCommand(["local-0123456789ab", "'; rm -rf / #", STORE_A]);
    const policy = JSON.parse(
      Buffer.from(/printf %s '([A-Za-z0-9+/=]+)'/.exec(command)![1]!, "base64").toString("utf8"),
    );
    expect(policy.ExtensionInstallForcelist).toHaveLength(1);
    expect(command).not.toContain("rm -rf");
  });

  it("is valid shell", () => {
    const check = spawnSync("bash", ["-n"], { input: boxExtensionPolicyCommand([STORE_A]), encoding: "utf8" });
    expect(check.status).toBe(0);
  });
});
