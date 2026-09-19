import { describe, expect, it } from "vitest";

import { CLOUD_COMPUTER_BUSY_ERROR } from "../../shared/computer-contention";
import {
  decideBoxErrorPhase,
  decideBoxPhase,
  decideLocalPhase,
  decideSelectionPhase,
  isVmAwaitingDesktop,
  decideVmPhase,
  decideVpsPhase,
  decideVpsProvisionPhase,
  type BoxComputerStatusSnapshot,
  type LocalVmStatus,
  type VpsComputerStatus,
} from "./computer-panel-phase";

const vmStatus = (overrides: Partial<LocalVmStatus> = {}): LocalVmStatus => ({
  mode: "per-bot",
  max_instances: 1,
  image: true,
  create_supported: true,
  container: "running",
  imageMatches: true,
  managed: true,
  network: "loopback",
  security: "hardened",
  persistence: "durable",
  desktopReady: true,
  ready: true,
  problem: null,
  viewer_url: "http://127.0.0.1:5901",
  ...overrides,
});

const vpsStatus = (overrides: Partial<VpsComputerStatus> = {}): VpsComputerStatus => ({
  configured: true,
  imageMatches: true,
  managed: true,
  container: "running",
  ready: false,
  problem: null,
  ...overrides,
});

const boxStatus = (overrides: Partial<BoxComputerStatusSnapshot> = {}): BoxComputerStatusSnapshot => ({
  configured: true,
  box: { state: "running" },
  teamComputer: null,
  problem: null,
  ...overrides,
});

describe("decideSelectionPhase", () => {
  it("Auto without a resolved surface has nothing to show", () => {
    expect(decideSelectionPhase(undefined)).toBe("auto-unavailable");
  });

  it("Off and browser-only bots settle without any backend call", () => {
    expect(decideSelectionPhase("off")).toBe("off");
    expect(decideSelectionPhase("browser")).toBe("browser");
  });

  it("backend families resolve their own phase", () => {
    expect(decideSelectionPhase("cloud")).toBeNull();
    expect(decideSelectionPhase("vm")).toBeNull();
    expect(decideSelectionPhase("local")).toBeNull();
  });
});

describe("decideLocalPhase", () => {
  it("capabilities read, host allows it and the engine supports it — local works", () => {
    expect(decideLocalPhase({ capabilitiesReady: true, localAvailable: true, providerSupportsLocal: true }))
      .toEqual({ phase: "local", error: null });
  });

  it("missing capabilities or host permission only blocks local, it is not an engine fault", () => {
    expect(decideLocalPhase({ capabilitiesReady: false, localAvailable: true, providerSupportsLocal: true }))
      .toEqual({ phase: "local-unavailable", error: null });
    expect(decideLocalPhase({ capabilitiesReady: true, localAvailable: false, providerSupportsLocal: true }))
      .toEqual({ phase: "local-unavailable", error: null });
  });

  it("an engine without local support decides both the phase and its error copy", () => {
    expect(decideLocalPhase({ capabilitiesReady: true, localAvailable: true, providerSupportsLocal: false }))
      .toEqual({ phase: "local-unavailable", error: { kind: "localized", key: "computer.err.localEngine" } });
    // the engine check alone decides the copy, even when more is missing
    expect(decideLocalPhase({ capabilitiesReady: false, localAvailable: false, providerSupportsLocal: false }).error)
      .toEqual({ kind: "localized", key: "computer.err.localEngine" });
  });
});

describe("decideVmPhase", () => {
  it("a missing engine wins over everything, even a ready status", () => {
    expect(decideVmPhase({ vmSupported: false, status: vmStatus({ ready: true }) }))
      .toEqual({ phase: "vm-unavailable", error: { kind: "localized", key: "computer.err.vmEngine" } });
  });

  it("a failed status request is unavailable, with the caller's own error", () => {
    expect(decideVmPhase({ vmSupported: true, status: null }))
      .toEqual({ phase: "vm-unavailable", error: null });
  });

  it("a ready VM shows the viewer even while its desktop flag is still unset", () => {
    expect(decideVmPhase({ vmSupported: true, status: vmStatus({ desktopReady: false }) }))
      .toEqual({ phase: "vm", error: null });
  });
});

describe("isVmAwaitingDesktop", () => {
  it("a healthy container still booting its desktop keeps checking", () => {
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false }), 0)).toBe(true);
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false }), 14)).toBe(true);
    // a ready status never waits, whatever the desktop flag says
    expect(isVmAwaitingDesktop(vmStatus({ ready: true, desktopReady: false }), 0)).toBe(false);
  });

  it("gives up on the desktop wait after fifteen attempts", () => {
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false }), 15)).toBe(false);
  });

  it("any unhealthy VM detail ends the wait", () => {
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false, container: "stopped" }), 0)).toBe(false);
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false, imageMatches: false }), 0)).toBe(false);
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false, managed: false }), 0)).toBe(false);
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false, network: "unsafe" }), 0)).toBe(false);
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false, security: "unsafe" }), 0)).toBe(false);
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: false, persistence: "unsafe" }), 0)).toBe(false);
    // a desktop that is ready while the VM is not is a fault, not a wait
    expect(isVmAwaitingDesktop(vmStatus({ ready: false, desktopReady: true }), 0)).toBe(false);
  });
});

describe("decideVmPhase repair copy", () => {
  it("a creatable per-bot VM is unavailable without an error — the panel offers Create", () => {
    expect(decideVmPhase({ vmSupported: true, status: vmStatus({ ready: false, container: "missing" }) }))
      .toEqual({ phase: "vm-unavailable", error: null });
  });

  it("anything not creatable here carries the settings-repair copy with the server's problem", () => {
    expect(decideVmPhase({
      vmSupported: true,
      status: vmStatus({ ready: false, container: "missing", mode: "shared", problem: "no ports" }),
    })).toEqual({
      phase: "vm-unavailable",
      error: {
        kind: "localized",
        key: "computer.err.vmOpenSettings",
        problem: "no ports",
        fallbackKey: "computer.err.vmNotReady",
      },
    });
    expect(decideVmPhase({
      vmSupported: true,
      status: vmStatus({ ready: false, container: "missing", create_supported: false }),
    }).error).toEqual({
      kind: "localized",
      key: "computer.err.vmOpenSettings",
      problem: null,
      fallbackKey: "computer.err.vmNotReady",
    });
  });
});

describe("decideVpsPhase", () => {
  it("a missing alias wins even when the status claims ready", () => {
    expect(decideVpsPhase({ status: vpsStatus({ configured: false, ready: true }), canManageCloud: true, autoStartVps: true }))
      .toEqual({ phase: "vps-unconfigured", error: { kind: "localized", key: "computer.err.vpsAlias" } });
  });

  it("a ready VPS is ready, even one carrying an incompatible image", () => {
    expect(decideVpsPhase({
      status: vpsStatus({ ready: true, imageMatches: false }),
      canManageCloud: false,
      autoStartVps: false,
    })).toEqual({ phase: "ready", error: null });
  });

  it("a managed container from an older image layer asks for replacement", () => {
    expect(decideVpsPhase({
      status: vpsStatus({ imageMatches: false, problem: "image v2 needed" }),
      canManageCloud: false,
      autoStartVps: false,
    })).toEqual({ phase: "vps-incompatible", error: { kind: "text", text: "image v2 needed" } });
    expect(decideVpsPhase({
      status: vpsStatus({ imageMatches: false, problem: null }),
      canManageCloud: false,
      autoStartVps: false,
    }).error).toBeNull();
  });

  it("incompatibility needs a managed container that is not missing", () => {
    expect(decideVpsPhase({
      status: vpsStatus({ imageMatches: false, container: "missing" }),
      canManageCloud: true,
      autoStartVps: false,
    }).phase).toBe("provision");
    expect(decideVpsPhase({
      status: vpsStatus({ imageMatches: false, managed: false }),
      canManageCloud: true,
      autoStartVps: false,
    }).phase).toBe("provision");
  });

  it("a person who can act always hands off to provisioning, stopped container included", () => {
    expect(decideVpsPhase({ status: vpsStatus({ container: "stopped" }), canManageCloud: true, autoStartVps: false }))
      .toEqual({ phase: "provision", error: null });
  });

  it("a stopped VPS nobody can act on shows the start path", () => {
    expect(decideVpsPhase({
      status: vpsStatus({ container: "stopped", problem: "asleep" }),
      canManageCloud: false,
      autoStartVps: false,
    })).toEqual({
      phase: "vps-stopped",
      error: {
        kind: "localized",
        key: "computer.err.vpsManual",
        problem: "asleep",
        fallbackKey: "computer.err.vpsNoContainer",
      },
    });
  });

  it("a missing container nobody can start reports auto or manual copy by preference", () => {
    expect(decideVpsPhase({
      status: vpsStatus({ container: "missing" }),
      canManageCloud: false,
      autoStartVps: true,
    })).toEqual({
      phase: "vps-unconfigured",
      error: { kind: "localized", key: "computer.err.vpsAuto", problem: null, fallbackKey: "computer.err.vpsNoContainer" },
    });
    expect(decideVpsPhase({
      status: vpsStatus({ container: "running" }),
      canManageCloud: false,
      autoStartVps: false,
    })).toEqual({
      phase: "vps-unconfigured",
      error: { kind: "localized", key: "computer.err.vpsManual", problem: null, fallbackKey: "computer.err.vpsNoContainer" },
    });
  });
});

describe("decideVpsProvisionPhase", () => {
  it("a ready result is ready", () => {
    expect(decideVpsProvisionPhase({ ready: true })).toEqual({ phase: "ready", error: null });
  });

  it("a problem is surfaced verbatim", () => {
    expect(decideVpsProvisionPhase({ ready: false, problem: "ssh handshake failed" }))
      .toEqual({ phase: "error", error: { kind: "text", text: "ssh handshake failed" } });
  });

  it("only a missing problem falls back to the generic copy — an empty string does not", () => {
    expect(decideVpsProvisionPhase({ ready: false, problem: null }).error)
      .toEqual({ kind: "localized", key: "computer.err.vpsNotReady" });
    expect(decideVpsProvisionPhase({ ready: false }).error)
      .toEqual({ kind: "localized", key: "computer.err.vpsNotReady" });
    expect(decideVpsProvisionPhase({ ready: false, problem: "" }).error)
      .toEqual({ kind: "text", text: "" });
  });
});

describe("decideBoxPhase", () => {
  it("explicit Cloud with no key and no team box is unconfigured, before any action", () => {
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: false,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ configured: false, box: null }),
    })).toEqual({ phase: "unconfigured", error: null });
  });

  it("an inherited team box is a shared resource with its own problem line", () => {
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: false,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ teamComputer: { id: "t1", name: "Team Box" }, problem: "shared quota" }),
    })).toEqual({ phase: "team-box", error: { kind: "text", text: "shared quota" } });
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: false,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ teamComputer: { id: "t1", name: "Team Box" }, problem: 42 }),
    }).error).toBeNull();
  });

  it("a ready box the turn already owns goes straight to ready", () => {
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: true,
      canUseCloud: true,
      busy: true,
      status: boxStatus({ box: { state: "running" } }),
    })).toEqual({ phase: "ready", error: null });
  });

  it("a mid-turn box that is not ready is the turn's business, not a fault", () => {
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: true,
      canUseCloud: true,
      busy: true,
      status: boxStatus({ box: { state: "archived" } }),
    }).phase).toBe("busy-box");
  });

  it("an observed ready box becomes ready only for an explicit Cloud selection", () => {
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: false,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ box: { state: "idle" } }),
    }).phase).toBe("ready");
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: false,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ box: { state: "archived" } }),
    }).phase).toBe("show-sleeping-box");
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: false,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ box: { state: "provisioning" } }),
    }).phase).toBe("show-pending-box");
  });

  it("an explicit Cloud choice that can act provisions; without cloud it cannot", () => {
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: true,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ box: { state: "archived" } }),
    })).toEqual({ phase: "ensure-box", error: null });
    expect(decideBoxPhase({
      computer: "cloud",
      canManageCloud: true,
      canUseCloud: false,
      busy: false,
      status: boxStatus(),
    }).phase).toBe("auto-unavailable");
  });

  it("auto with cloud rights observes a configured box but never provisions it", () => {
    expect(decideBoxPhase({
      computer: undefined,
      canManageCloud: true,
      canUseCloud: true,
      busy: false,
      status: boxStatus({ box: { state: "archived" } }),
    }).phase).toBe("show-sleeping-box");
  });

  it("auto without a configured box and without cloud falls through to unavailable", () => {
    expect(decideBoxPhase({
      computer: undefined,
      canManageCloud: false,
      canUseCloud: false,
      busy: false,
      status: boxStatus({ configured: false, box: null }),
    }).phase).toBe("auto-unavailable");
  });
});

describe("decideBoxErrorPhase", () => {
  it("the server's active-turn refusal is a wait, however wrapped", () => {
    expect(decideBoxErrorPhase({ status: 409, message: CLOUD_COMPUTER_BUSY_ERROR }).phase).toBe("busy-box");
    expect(decideBoxErrorPhase({ status: 409, message: "wrap: " + CLOUD_COMPUTER_BUSY_ERROR }).phase).toBe("busy-box");
    expect(decideBoxErrorPhase({ message: CLOUD_COMPUTER_BUSY_ERROR }).phase).toBe("busy-box");
  });

  it("screenshot-poll contention re-resolves instead of faulting", () => {
    expect(decideBoxErrorPhase({
      status: 409,
      message: "this bot's cloud computer is being changed — wait for it to finish",
    }).phase).toBe("checking");
    expect(decideBoxErrorPhase({
      status: 409,
      message: "the VPS is being prepared — try again shortly",
    }).phase).toBe("checking");
  });

  it("everything else is a fault, including a busy message with a foreign status", () => {
    expect(decideBoxErrorPhase({ status: 404, message: CLOUD_COMPUTER_BUSY_ERROR }).phase).toBe("error");
    expect(decideBoxErrorPhase({ status: 500, message: "boom" }).phase).toBe("error");
    expect(decideBoxErrorPhase(new Error("boom")).phase).toBe("error");
  });
});
