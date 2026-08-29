import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  desktopLaunchPolicy,
  isolatedCanaryDataPaths,
  registerIsolatedCompanionIpc,
} from "./isolated-canary.mjs";

describe("isolated packaged canary policy", () => {
  it("preserves every normal packaged startup integration by default", () => {
    expect(desktopLaunchPolicy({})).toEqual({
      isolated: false,
      companionIpc: true,
      companionAccountIpc: true,
      registerProtocol: true,
      restoreCompanion: true,
      restoreHostedAccount: true,
      registerHostedApps: true,
      updater: true,
    });
  });

  it("disables global, hosted, companion, and updater side effects explicitly", () => {
    expect(desktopLaunchPolicy({ OMB_ISOLATED_CANARY: "1" })).toEqual({
      isolated: true,
      companionIpc: false,
      companionAccountIpc: false,
      registerProtocol: false,
      restoreCompanion: false,
      restoreHostedAccount: false,
      registerHostedApps: false,
      updater: false,
    });
  });

  it("does not accept truthy lookalikes", () => {
    expect(desktopLaunchPolicy({ OMB_ISOLATED_CANARY: "true" }).isolated).toBe(false);
  });

  it("fails closed from the packaged canary version even if its env flag is omitted", () => {
    expect(desktopLaunchPolicy({}, { appVersion: "0.1.40-autorag-canary.1" })).toMatchObject({
      isolated: true,
      registerProtocol: false,
      companionIpc: false,
      companionAccountIpc: false,
      updater: false,
    });
    expect(desktopLaunchPolicy({}, { appVersion: "0.1.40" }).isolated).toBe(false);
  });

  it("derives a distinct absolute state root for an auto-detected packaged canary", () => {
    const tempRoot = path.join(path.parse(process.cwd()).root, "tmp");
    const resolved = isolatedCanaryDataPaths({}, path, {
      tempRoot,
      appVersion: "0.1.40-autorag-canary.1",
    });
    expect(resolved.root).toBe(path.join(
      tempRoot,
      "OpenMausBot-Isolated-Canary",
      "0.1.40-autorag-canary.1",
    ));
    expect(resolved.userData).toBe(path.join(resolved.root, "electron-user-data"));
    expect(resolved.serverData).toBe(path.join(resolved.root, "server-data"));
  });

  it("preserves an explicit canary state root and rejects unsafe roots", () => {
    expect(() => isolatedCanaryDataPaths({}, path)).toThrow(/must be an absolute/);
    expect(() => isolatedCanaryDataPaths({ OMB_ISOLATED_CANARY_DATA_ROOT: "." }, path))
      .toThrow(/must be an absolute/);
    expect(() => isolatedCanaryDataPaths({ OMB_ISOLATED_CANARY_DATA_ROOT: path.parse(process.cwd()).root }, path))
      .toThrow(/filesystem root/);
    const explicitRoot = path.join(process.cwd(), ".canary-state");
    const resolved = isolatedCanaryDataPaths({
      OMB_ISOLATED_CANARY_DATA_ROOT: explicitRoot,
    }, path, {
      tempRoot: path.join(path.parse(process.cwd()).root, "tmp"),
      appVersion: "0.1.40-autorag-canary.1",
    });
    expect(resolved.root).toBe(explicitRoot);
    expect(resolved.userData).toBe(path.join(resolved.root, "electron-user-data"));
    expect(resolved.serverData).toBe(path.join(resolved.root, "server-data"));
    expect(resolved.userData).not.toBe(resolved.serverData);
  });

  it("keeps every companion and account IPC call inert without a hosted probe", async () => {
    const handlers = new Map();
    registerIsolatedCompanionIpc({
      handle: (channel, handler) => handlers.set(channel, handler),
    });

    expect([...handlers.keys()].sort()).toEqual([
      "companion-account:request-code",
      "companion-account:retry",
      "companion-account:sign-out",
      "companion-account:state",
      "companion-account:verify-code",
      "companion:cloud-desktop",
      "companion:keep-awake",
      "companion:pairing",
      "companion:revoke",
      "companion:start",
      "companion:state",
      "companion:stop",
    ]);
    for (const channel of handlers.keys()) {
      const state = await handlers.get(channel)();
      if (channel.startsWith("companion-account:")) {
        expect(state).toEqual({
          available: false,
          status: "signed-out",
          message: "Secure phone access is disabled in this isolated canary.",
        });
      } else {
        expect(state).toMatchObject({ enabled: false, port: 0, devices: [], pairing: null });
      }
    }
  });
});
