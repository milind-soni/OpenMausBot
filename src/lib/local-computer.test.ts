import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoSelectsLocalComputer,
  busyBoatView,
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  resolveBoatPanelAction,
  shouldPollCloudPreview,
} from "./local-computer";

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = {
      modelSelection: { instanceId: "claude", model: "test" },
    } satisfies Pick<Bot, "modelSelection">;
    const instances = [
      {
        instanceId: "claude",
        capabilities: { localComputerMcp: true },
      },
    ] satisfies Array<Pick<InstanceInfo, "instanceId" | "capabilities">>;
    expect(instanceSupportsLocalComputer(instances as InstanceInfo[], bot)).toBe(true);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: {} }] as InstanceInfo[],
        bot,
      ),
    ).toBe(false);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: { computerMcp: true } }] as InstanceInfo[],
        bot,
      ),
    ).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "linux" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("keeps This computer selectable on Windows before the driver is live", () => {
    const capabilities = {
      host: { platform: "win32" as const, label: "Windows" },
      localComputer: { available: false, enabled: false, status: "unavailable" },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(localComputerDisabledReason({ capabilities, providerSupportsLocal: true })).toBe(
      "Bots can't use this PC right now. Restart MausBot, and if that doesn't help, open Settings → Diagnostics.",
    );
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "linux",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = {
      host: { platform: "linux" as const },
      localComputer: {
        available: false,
        enabled: false,
        reasonCode: "linux-wayland-seat-safety-blocked",
      },
    } as DesktopCapabilities;

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "Bots can't use this computer in this kind of desktop session yet. Sign out, choose “Ubuntu on Xorg” on the sign-in screen, and sign back in.",
    );
  });

  it("preserves the ready local fallback on supported non-Linux hosts", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(true);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: "cloud",
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("reports an inherited team Boat without choosing a private Boat or local fallback", () => {
    for (const configured of [false, true]) {
      for (const boatState of [null, "idle", "archived", "provisioning"]) {
        for (const canUseCloud of [false, true]) {
          expect(resolveBoatPanelAction({ computer: undefined, configured, boatState, canUseCloud,
            autoLocal: true, teamComputer: true })).toBe("team-boat");
        }
      }
    }
    expect(resolveBoatPanelAction({ computer: "cloud", configured: true, boatState: "idle",
      canUseCloud: true, autoLocal: true, teamComputer: true })).toBe("attach-ready-boat");
  });

  it("never creates a missing Boat merely because an Auto panel opened", () => {
    expect(
      resolveBoatPanelAction({
        computer: undefined,
        configured: true,
        boatState: null,
        canUseCloud: true,
        autoLocal: true,
      }),
    ).toBe("local");
    expect(
      resolveBoatPanelAction({
        computer: undefined,
        configured: true,
        boatState: null,
        canUseCloud: true,
        autoLocal: false,
      }),
    ).toBe("auto-unavailable");
  });

  it("shows existing Auto Boats without provisioning or waking them", () => {
    const base = {
      configured: true,
      canUseCloud: true,
      autoLocal: true,
      computer: undefined,
    };
    for (const boatState of ["idle", "ready", "running"]) {
      expect(resolveBoatPanelAction({ ...base, boatState })).toBe("show-ready-boat");
    }
    for (const boatState of ["archived", "stopped"]) {
      expect(resolveBoatPanelAction({ ...base, boatState })).toBe("show-sleeping-boat");
    }
    for (const boatState of ["provisioning", "creating", "unknown-provider-state"]) {
      expect(resolveBoatPanelAction({ ...base, boatState })).toBe("show-pending-boat");
    }
  });

  it("never creates or wakes a Boat because Cloud computer was chosen or the panel opened", () => {
    const cloud = { computer: "cloud" as const, configured: true, canUseCloud: true, autoLocal: true };
    expect(resolveBoatPanelAction({ ...cloud, boatState: null })).toBe("cloud-new");
    for (const boatState of ["archived", "stopped"]) {
      expect(resolveBoatPanelAction({ ...cloud, boatState })).toBe("cloud-asleep");
    }
    for (const boatState of ["idle", "ready", "running"]) {
      expect(resolveBoatPanelAction({ ...cloud, boatState })).toBe("attach-ready-boat");
    }
    expect(resolveBoatPanelAction({ ...cloud, boatState: "provisioning" })).toBe("busy-boat");
  });

  it("watches instead of provisioning while a turn owns the box", () => {
    const cloud = { computer: "cloud" as const, configured: true, canUseCloud: true, autoLocal: true, busy: true };
    for (const boatState of ["ready", "idle", "running"]) {
      expect(resolveBoatPanelAction({ ...cloud, boatState })).toBe("attach-ready-boat");
    }
    for (const boatState of ["archived", "stopped", "provisioning", null]) {
      expect(resolveBoatPanelAction({ ...cloud, boatState })).toBe("busy-boat");
    }
    expect(resolveBoatPanelAction({ ...cloud, boatState: "ready", canUseCloud: false })).toBe("auto-unavailable");
    expect(resolveBoatPanelAction({ ...cloud, computer: undefined, boatState: "ready" })).toBe("show-ready-boat");
    expect(resolveBoatPanelAction({ ...cloud, computer: undefined, boatState: null, autoLocal: false })).toBe("auto-unavailable");
  });

  it("while it watches, spins only for a cloud computer that is really starting", () => {
    expect(busyBoatView(null, true)).toEqual({ line: "computer.cloud.new", spinner: false });
    expect(busyBoatView(null, false)).toEqual({ line: "computer.cloud.new", spinner: false });
    for (const boatState of ["archived", "stopped"]) {
      expect(busyBoatView(boatState, true)).toEqual({ line: "computer.cloud.asleep", spinner: false });
      expect(busyBoatView(boatState, false)).toEqual({ line: "computer.cloud.asleep", spinner: false });
    }
    expect(busyBoatView("provisioning", true)).toEqual({ line: "computer.phase.busyBoat", spinner: true });
    expect(busyBoatView("resuming", false)).toEqual({ line: "computer.phase.starting", spinner: true });
  });

  it("never gives any engine a passive Auto creation exception", () => {
    expect(resolveBoatPanelAction({
      computer: undefined,
      configured: true,
      boatState: null,
      canUseCloud: true,
      autoLocal: false,
    })).toBe("auto-unavailable");
    expect(resolveBoatPanelAction({
      computer: undefined,
      configured: true,
      boatState: "archived",
      canUseCloud: true,
      autoLocal: false,
    })).toBe("show-sleeping-boat");
  });

  it("falls back locally when the selected engine cannot use an existing Boat", () => {
    expect(
      resolveBoatPanelAction({
        computer: undefined,
        configured: true,
        boatState: "running",
        canUseCloud: false,
        autoLocal: true,
      }),
    ).toBe("local");
  });

  it("refuses cloud preview polling when a stale ready phase belongs to Auto or another destination", () => {
    const ready = {
      computer: "cloud" as const,
      cloudBackend: "box" as const,
      phase: "ready",
      botId: "bot-a",
      resolvedBotId: "bot-a",
      resolvedComputer: "cloud" as const,
      resolvedCloudBackend: "box" as const,
    };
    expect(shouldPollCloudPreview(ready)).toBe(true);
    expect(shouldPollCloudPreview({ ...ready, computer: undefined })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, computer: "local" })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, phase: "starting" })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, botId: "bot-b" })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, resolvedBotId: null })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, resolvedComputer: undefined })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, cloudBackend: "vps" })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, resolvedCloudBackend: "vps" })).toBe(false);
  });

  it("rejects stale persisted selections in both cloud-backend switch directions", () => {
    const expected = { computer: "cloud" as const, cloudBackend: "box" as const };
    expect(persistedComputerSelectionMatches({ ...expected, persistedBot: expected })).toBe(true);
    expect(persistedComputerSelectionMatches({
      ...expected,
      persistedBot: { computer: "cloud", cloudBackend: "vps" },
    })).toBe(false);
    expect(persistedComputerSelectionMatches({
      computer: "cloud",
      cloudBackend: "vps",
      persistedBot: { computer: "cloud", cloudBackend: "box" },
    })).toBe(false);
    expect(persistedComputerSelectionMatches({
      ...expected,
      persistedBot: { computer: undefined, cloudBackend: "box" },
    })).toBe(false);
  });
});

describe("what the person reads about using this computer", () => {
  const JARGON = /DevTools|CDP|profile[- ]access|grant\b|bind to|attach|endpoint|driver|\bCUA\b|Cua\b|Boat key|ACP|provider|Wayland|descriptor/i;
  const host = (platform: DesktopCapabilities["host"]["platform"], label = "Desktop") => ({ platform, label }) as DesktopCapabilities["host"];
  const reasons = [
    localComputerDisabledReason({ capabilities: { host: host("darwin"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: false }),
    localComputerDisabledReason({ capabilities: { host: host("darwin"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    localComputerDisabledReason({ capabilities: { host: host("win32"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    localComputerDisabledReason({ capabilities: { host: host("other", "Browser"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    ...["linux-wayland-seat-safety-blocked", "wayland-compositor-unsupported", undefined].map((reasonCode) =>
      localComputerDisabledReason({ capabilities: { host: host("linux"), localComputer: { available: false, enabled: reasonCode !== undefined, reasonCode } } as DesktopCapabilities, providerSupportsLocal: true })),
    localComputerDisabledReason({ capabilities: { host: host("linux"), localComputer: { available: false, enabled: true } } as DesktopCapabilities, providerSupportsLocal: true }),
  ];

  it("says what to do in plain words, never the parts underneath", () => {
    expect(reasons.every((reason) => typeof reason === "string" && reason.length > 0)).toBe(true);
    for (const reason of reasons) expect(reason, reason!).not.toMatch(JARGON);
    expect(reasons[3]).toBe("Only the MausBot app on this computer can let a bot use it. Open the app here to use it.");
  });

  it("keeps the same plain words in the questions and the place lines the app shows", () => {
    const shown = Object.entries(en as Record<string, string>).filter(([key]) =>
      key.startsWith("approval.yourComputer.") || key.startsWith("computer.problem.local") || key.startsWith("place.view.") || key.startsWith("place.action."));
    expect(shown.length).toBeGreaterThan(40);
    for (const [key, text] of shown) expect(text, key).not.toMatch(/DevTools|profile[- ]access|grant\b|bind to|\bCUA\b|Cua Driver|Boat key/i);
    // Boat makes the cloud desktops, and is named where they are offered.
    expect((en as Record<string, string>)["place.view.ccNeedsKey.line"]).toContain("from Boat");
  });
});
