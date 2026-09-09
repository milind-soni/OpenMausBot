import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  resolveBoxPanelAction,
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

  it("states that Linux Auto never selects this computer", () => {
    expect(linuxAutoDescription()).toContain("otherwise computer use stays off");
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
      "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.",
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

  it("never creates a missing Box merely because an Auto panel opened", () => {
    expect(
      resolveBoxPanelAction({
        computer: undefined,
        configured: true,
        boxState: null,
        canUseCloud: true,
        autoLocal: true,
      }),
    ).toBe("local");
    expect(
      resolveBoxPanelAction({
        computer: undefined,
        configured: true,
        boxState: null,
        canUseCloud: true,
        autoLocal: false,
      }),
    ).toBe("auto-unavailable");
  });

  it("shows existing Auto Boxes without provisioning or waking them", () => {
    const base = {
      configured: true,
      canUseCloud: true,
      autoLocal: true,
      computer: undefined,
    };
    for (const boxState of ["idle", "ready", "running"]) {
      expect(resolveBoxPanelAction({ ...base, boxState })).toBe("show-ready-box");
    }
    for (const boxState of ["archived", "stopped"]) {
      expect(resolveBoxPanelAction({ ...base, boxState })).toBe("show-sleeping-box");
    }
    for (const boxState of ["provisioning", "creating", "unknown-provider-state"]) {
      expect(resolveBoxPanelAction({ ...base, boxState })).toBe("show-pending-box");
    }
  });

  it("provisions only after an explicit Cloud choice", () => {
    expect(resolveBoxPanelAction({
      computer: "cloud",
      configured: true,
      boxState: null,
      canUseCloud: true,
      autoLocal: true,
    })).toBe("ensure-box");
    expect(resolveBoxPanelAction({
      computer: "cloud",
      configured: true,
      boxState: "archived",
      canUseCloud: true,
      autoLocal: true,
    })).toBe("ensure-box");
  });

  it("never gives the box-native engine a passive Auto creation exception", () => {
    // Engine kind intentionally is not an input: every engine follows the
    // same read-only Auto rule, including boxAgent.
    expect(resolveBoxPanelAction({
      computer: undefined,
      configured: true,
      boxState: null,
      canUseCloud: true,
      autoLocal: false,
    })).toBe("auto-unavailable");
    expect(resolveBoxPanelAction({
      computer: undefined,
      configured: true,
      boxState: "archived",
      canUseCloud: true,
      autoLocal: false,
    })).toBe("show-sleeping-box");
  });

  it("falls back locally when the selected engine cannot use an existing Box", () => {
    expect(
      resolveBoxPanelAction({
        computer: undefined,
        configured: true,
        boxState: "running",
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
