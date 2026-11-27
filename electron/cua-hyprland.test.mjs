import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  HYPRCTL,
  PACMAN,
  PLUGIN_REQUIRED_MESSAGE,
  isHyprlandSession,
  parseCuaPluginStatus,
  probeCuaHyprlandPlugin,
  runBounded,
  systemDriverPackageVersion,
} = require("./cua-hyprland.cjs");

const HYPRLAND = {
  XDG_SESSION_TYPE: "wayland",
  WAYLAND_DISPLAY: "wayland-1",
  XDG_CURRENT_DESKTOP: "Hyprland",
  HYPRLAND_INSTANCE_SIGNATURE: "6f2a0c1e_1762560000_123456789",
};

/** `hyprctl -j cua:status` from an input build with input enabled (libs/cua-driver/hyprland-plugin/src/plugin.cpp). */
function activeStatus(overrides = {}) {
  return {
    name: "cua-hyprland-plugin",
    plugin_version: "0.41.3",
    state: "input_v3_candidate",
    protocol: { major: 1, minor: 0, max_frame_bytes: 65536 },
    compositor_epoch: 1,
    abi: { compiled_hash: "abc", runtime_hash: "abc", match: true },
    configured: true,
    transport: { ready: true, socket: "/run/user/1000/hypr/x/.cua.sock", mode: "0600", peer_policy: "same_uid", last_error: "" },
    capabilities: { supported: ["discovery"], enabled: ["discovery"], mutation: "trusted_local_per_action" },
    input: { protocol: 3, test_only: false, transport_ready: true, lanes: [] },
    ...overrides,
  };
}

describe("isHyprlandSession", () => {
  it("needs Hyprland's instance signature and a desktop named Hyprland", () => {
    expect(isHyprlandSession(HYPRLAND)).toBe(true);
    expect(isHyprlandSession({ ...HYPRLAND, XDG_CURRENT_DESKTOP: "", XDG_SESSION_DESKTOP: "hyprland" })).toBe(true);
    expect(isHyprlandSession({ ...HYPRLAND, XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(false);
    expect(isHyprlandSession({ ...HYPRLAND, XDG_CURRENT_DESKTOP: "sway" })).toBe(false);
    expect(isHyprlandSession({ ...HYPRLAND, HYPRLAND_INSTANCE_SIGNATURE: "" })).toBe(false);
    expect(isHyprlandSession({ ...HYPRLAND, HYPRLAND_INSTANCE_SIGNATURE: "../../evil" })).toBe(false);
    expect(isHyprlandSession({})).toBe(false);
  });
});

describe("parseCuaPluginStatus", () => {
  it("is active only for a configured input build with a ready transport and matching ABI", () => {
    expect(parseCuaPluginStatus(JSON.stringify(activeStatus()))).toBe("active");
    for (const status of [
      activeStatus({ state: "discovery_only" }),
      activeStatus({ state: "input_experiment" }),
      activeStatus({ configured: false }),
      activeStatus({ abi: { compiled_hash: "a", runtime_hash: "b", match: false } }),
      activeStatus({ transport: { ready: false } }),
      activeStatus({ input: { protocol: 3, test_only: false, transport_ready: false } }),
      activeStatus({ input: { protocol: 3, test_only: true, transport_ready: true } }),
      activeStatus({ input: { protocol: 2, test_only: false, transport_ready: true } }),
      activeStatus({ input: undefined }),
      activeStatus({ name: "some-other-plugin" }),
    ]) {
      expect(parseCuaPluginStatus(JSON.stringify(status)), JSON.stringify(status)).toBe("inactive");
    }
  });

  it("treats hyprctl's text for an unknown request and malformed output as inactive", () => {
    for (const output of ["unknown request", "", "null", "[]", "{", '"active"', undefined]) {
      expect(parseCuaPluginStatus(output)).toBe("inactive");
    }
  });
});

describe("probeCuaHyprlandPlugin", () => {
  it("asks the system hyprctl, never one from PATH, with the session's instance signature", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(activeStatus()) }));
    await expect(probeCuaHyprlandPlugin({ env: { ...HYPRLAND, PATH: "/tmp/evil" }, run, exists: () => true })).resolves.toBe("active");
    expect(run).toHaveBeenCalledOnce();
    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe(HYPRCTL);
    expect(args).toEqual(["-j", "cua:status"]);
    expect(options.env.HYPRLAND_INSTANCE_SIGNATURE).toBe(HYPRLAND.HYPRLAND_INSTANCE_SIGNATURE);
    expect(options.env.LC_ALL).toBe("C");
  });

  it("does not run anything outside a Hyprland session or without the system hyprctl", async () => {
    const run = vi.fn();
    await expect(probeCuaHyprlandPlugin({ env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" }, run, exists: () => true })).resolves.toBe("inactive");
    await expect(probeCuaHyprlandPlugin({ env: HYPRLAND, run, exists: () => false })).resolves.toBe("inactive");
    expect(run).not.toHaveBeenCalled();
  });

  it("is inactive when hyprctl fails or times out", async () => {
    await expect(probeCuaHyprlandPlugin({ env: HYPRLAND, run: async () => ({ exitCode: 1, stdout: JSON.stringify(activeStatus()) }), exists: () => true })).resolves.toBe("inactive");
    await expect(probeCuaHyprlandPlugin({ env: HYPRLAND, run: async () => ({ exitCode: null, stdout: "" }), exists: () => true })).resolves.toBe("inactive");
  });
});

describe("systemDriverPackageVersion", () => {
  const owned = (stdout, exitCode = 0) => vi.fn(async () => ({ exitCode, stdout }));

  it("returns the version only when cua-driver-bin owns exactly that file", async () => {
    const run = owned("/usr/bin/cua-driver is owned by cua-driver-bin 0.41.3-1\n");
    await expect(systemDriverPackageVersion("/usr/bin/cua-driver", { run, exists: () => true })).resolves.toBe("0.41.3-1");
    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe(PACMAN);
    expect(args).toEqual(["-Qo", "/usr/bin/cua-driver"]);
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
  });

  it("refuses another owner, another file, a failed query or a relative path", async () => {
    const exists = () => true;
    await expect(systemDriverPackageVersion("/usr/bin/cua-driver", { run: owned("/usr/bin/cua-driver is owned by cua-driver-git 9.9.9-1"), exists })).resolves.toBeNull();
    await expect(systemDriverPackageVersion("/usr/bin/cua-driver", { run: owned("/usr/bin/cua-driverx is owned by cua-driver-bin 0.41.3-1"), exists })).resolves.toBeNull();
    await expect(systemDriverPackageVersion("/usr/bin/cua-driver", { run: owned("error: No package owns /usr/bin/cua-driver", 1), exists })).resolves.toBeNull();
    await expect(systemDriverPackageVersion("/usr/bin/cua-driver", { run: owned("/usr/bin/cua-driver is owned by cua-driver-bin 0.41.3-1\nextra"), exists })).resolves.toBeNull();
    const never = vi.fn();
    await expect(systemDriverPackageVersion("usr/bin/cua-driver", { run: never, exists })).resolves.toBeNull();
    await expect(systemDriverPackageVersion("/usr/bin/cua-driver", { run: never, exists: () => false })).resolves.toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe("runBounded", () => {
  it("kills a command that runs past its deadline", async () => {
    const started = Date.now();
    await expect(runBounded(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 200 })).resolves.toEqual({ exitCode: null, stdout: "" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns a quick command's output", async () => {
    await expect(runBounded(process.execPath, ["-e", "process.stdout.write('ok')"])).resolves.toEqual({ exitCode: 0, stdout: "ok" });
  });
});

it("tells the person how to turn the plugin on in one sentence with Cua's guide", () => {
  expect(PLUGIN_REQUIRED_MESSAGE).toMatch(/cua-hyprland-plugin/);
  expect(PLUGIN_REQUIRED_MESSAGE).toMatch(/https:\/\/cua\.ai\/docs\/cua-sdk\/guides\/omarchy/);
  expect(PLUGIN_REQUIRED_MESSAGE.split(/\.\s/).length).toBe(1);
});
