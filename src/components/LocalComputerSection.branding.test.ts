import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import { LocalComputerSection } from "./LocalComputerSection";

const fixture = vi.hoisted(() => ({ calls: 0, status: {
  platform: "linux", runtime: "docker", available: ["docker"], daemonUp: true,
  image: true, imageMatches: true, managed: true, container: "running", ready: true,
  network: "loopback", security: "hardened", persistence: "durable", mode: "shared",
  problem: null, workspace_guest_path: "/home/cua/workspace",
  workspace_path: "/fixture/.openmausbot/vm-home",
  image_ref: "localhost/openmausbot/cua-local-vm:driver-0.20.0-v5",
  base_image_ref: "legacy-provider-image", driver_version: "0.20.0",
  container_name: "openmausbot-computer", viewer_url: "#fixture-desktop",
  commands: { pull: "docker pull openmausbot/image", run: "docker run --name openmausbot-computer", install: null, runtimeStart: null },
} }));

// Supply a completed owned status read; render the actual settings component
// and its real cards, labels and controls without reaching any live server.
vi.mock("react", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ...react, useState: (initial: unknown) => {
    const call = fixture.calls++;
    return react.useState(call === 0 ? fixture.status : call === 1 ? false : initial);
  } };
});
afterEach(() => { fixture.calls = 0; setLocale("en"); });

it("does not display legacy desktop identifiers while retaining setup, viewing and cleanup controls", () => {
  setLocale("en");
  const html = renderToStaticMarkup(createElement(LocalComputerSection));
  expect(html).not.toMatch(/open.?muse|openmaus|legacy-provider-image/i);
  expect(html).toContain("/home/cua/workspace");
  expect(html).toContain("#fixture-desktop");
  expect(html).toContain(t("vm.main.recheck"));
  expect(html).toContain("Prepare");
  expect(html).toContain("Stop");
});
