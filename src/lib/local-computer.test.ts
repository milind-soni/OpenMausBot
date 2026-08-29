import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
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

  it("keeps This computer selectable on macOS and Windows before CUA is ready", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "win32" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(true);
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
});
