import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  deriveSidebarPhoneStatus,
  phoneSettingsAction,
  SIDEBAR_PHONE_RECENT_MS,
  SidebarPhoneStatusButton,
  type SidebarPhoneStatus,
} from "./SidebarPhoneButton";

const device = (lastSeenAt: number) => ({
  id: "phone-1",
  name: "iPhone",
  createdAt: lastSeenAt,
  lastSeenAt,
  cloudDesktopAccess: false,
});

describe("sidebar phone status", () => {
  const now = 1_900_000_000_000;

  it("uses neutral plus semantics when no device is paired", () => {
    expect(deriveSidebarPhoneStatus({ enabled: true, devices: [], connectedDeviceIds: [] }, now)).toEqual({
      kind: "unpaired",
      label: "Pair a device",
      pairedCount: 0,
      connectedCount: 0,
    });
  });

  it("reports off and failed sidecars before offering to pair an empty device list", () => {
    expect(deriveSidebarPhoneStatus({
      enabled: false,
      devices: [],
      connectedDeviceIds: [],
    }, now)).toEqual({
      kind: "unavailable",
      label: "Remote access off",
      pairedCount: 0,
      connectedCount: 0,
    });
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [],
      connectedDeviceIds: [],
      error: "sidecar unavailable",
    }, now)).toEqual({
      kind: "unavailable",
      label: "Device status unavailable",
      pairedCount: 0,
      connectedCount: 0,
    });
  });

  it("turns green only for a paired device with a live authenticated stream", () => {
    const recent = device(now - SIDEBAR_PHONE_RECENT_MS);
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [recent],
      connectedDeviceIds: ["phone-1"],
    }, now)).toMatchObject({ kind: "connected", label: "Device connected", connectedCount: 1 });
    expect(
      deriveSidebarPhoneStatus({ enabled: true, devices: [recent], connectedDeviceIds: [] }, now),
    ).toMatchObject({ kind: "disconnected", label: "Device paired — not connected" });
    expect(deriveSidebarPhoneStatus({
      enabled: false,
      devices: [recent],
      connectedDeviceIds: ["phone-1"],
    }, now).kind).toBe("unavailable");
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [recent],
      connectedDeviceIds: ["phone-1"],
      error: "not responding",
    }, now).kind).toBe("unavailable");
  });

  it("reports partial live connectivity without implying every paired device is online", () => {
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [device(now - 1_000), { ...device(now - SIDEBAR_PHONE_RECENT_MS - 1), id: "phone-2" }],
      connectedDeviceIds: ["phone-1"],
    }, now)).toMatchObject({
      kind: "connected",
      label: "1 of 2 devices connected",
      pairedCount: 2,
      connectedCount: 1,
    });
  });

  it("keeps the older last-seen compatibility status neutral", () => {
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [device(now - 1_000)],
    }, now)).toMatchObject({
      kind: "recent",
      label: "Device active recently",
      connectedCount: 0,
    });
  });

  it("opens Settings directly on the internal Remote access section", () => {
    expect(phoneSettingsAction()).toEqual({
      type: "toggleAppSettings",
      open: true,
      section: "companion",
    });
  });
});

describe("SidebarPhoneStatusButton", () => {
  const render = (density: "comfortable" | "compact" | "icons", status: SidebarPhoneStatus) =>
    renderToStaticMarkup(createElement(SidebarPhoneStatusButton, {
      density,
      status,
      onOpen: vi.fn(),
    }));

  it("keeps its plain status accessible in the full sidebar without exposing connection details", () => {
    const markup = render("comfortable", {
      kind: "connected",
      label: "Device connected",
      pairedCount: 1,
      connectedCount: 1,
    });

    expect(markup).toContain('aria-label="Device connected"');
    expect(markup).toContain('title="Device connected"');
    expect(markup).toContain('data-sidebar-density="comfortable"');
    expect(markup).toContain('data-phone-status="connected"');
    expect(markup).toContain("data-phone-connected");
    expect(markup).toContain("text-success");
    expect(markup).not.toMatch(/192\.168|\.local|\.ts\.net|Pairing address/);
  });

  it("stays a centered compact control and shows the plus only when unpaired", () => {
    const unpaired = render("icons", {
      kind: "unpaired",
      label: "Pair a device",
      pairedCount: 0,
      connectedCount: 0,
    });
    const stale = render("icons", {
      kind: "stale",
      label: "Device paired — not recently active",
      pairedCount: 1,
      connectedCount: 0,
    });

    expect(unpaired).toContain('data-sidebar-density="icons"');
    expect(unpaired).toContain("mx-auto");
    expect(unpaired).toContain("data-phone-plus");
    expect(stale).not.toContain("data-phone-plus");
    expect(stale).not.toContain("text-success");
  });

  it("uses the same fixed-size control in the compact text sidebar", () => {
    const markup = render("compact", {
      kind: "stale",
      label: "Device paired — not recently active",
      pairedCount: 1,
      connectedCount: 0,
    });

    expect(markup).toContain('data-sidebar-density="compact"');
    expect(markup).toContain("size-10");
    expect(markup).toContain("shrink-0");
  });
});
