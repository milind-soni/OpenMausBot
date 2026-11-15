import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CompanionBridge } from "../lib/companion-types";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhonesList", () => ({ PhonesList: () => null }));
vi.mock("./ServerPairingCard", async () => {
  const { createElement: h } = await import("react");
  return { ServerPairingCard: (props: { forComputer?: boolean; address?: string | null }) => h("div", { "data-pairing-card": props.forComputer ? "computer" : "phone", "data-address": props.address }) };
});
vi.mock("../lib/session", async (original) => ({ ...await original<typeof import("../lib/session")>(), readSessionState: async () => ({ kind: "loopback" }) }));

const { deriveTailscalePairingStatus } = await import("./PhoneDevicesSection");
const { TailnetComputers, setComputerShare, tailnetShareLine } = await import("./TailnetComputers");

const controller = { busy: false, accountBusy: false, act: async () => {} } as unknown as PhoneSetupController;
const tailscale = (on: boolean, computers = false) => (on ? { on: true, since: 1, name: "macmini.tail1234.ts.net", computers } : { on: false, since: null });
const row = (state: Partial<CompanionState>, blocked: string | null = null) => renderToStaticMarkup(createElement(TailnetComputers, {
  c: controller, blocked, simple: true, state: state as CompanionState, status: deriveTailscalePairingStatus(state as CompanionState),
})).replaceAll("&#x27;", "'");
const shared = { on: true, origin: "http://macmini.tail1234.ts.net:8799", https: false, problem: null };

describe("the line under Your other computers", () => {
  it("says nothing while the share is off", () => {
    expect(tailnetShareLine(undefined)).toBeNull();
    expect(tailnetShareLine({ on: false, origin: null, https: false, problem: null })).toBeNull();
  });

  it("names the exact address another computer opens, and how it is protected", () => {
    const https = tailnetShareLine({ on: true, origin: "https://macmini.tail1234.ts.net", https: true, problem: null });
    expect(https).toContain("https://macmini.tail1234.ts.net");
    expect(https).toContain("HTTPS certificate");
    const http = tailnetShareLine(shared);
    expect(http).toContain("http://macmini.tail1234.ts.net:8799");
    expect(http).toContain("WireGuard");
  });

  it("says Tailscale isn't connected while nothing answers", () => {
    expect(tailnetShareLine({ on: true, origin: null, https: false, problem: "not-listening" })).toContain("isn't connected");
  });
});

describe("the Your other computers row", () => {
  it("is there with Tailscale off: a switch that is off, and what it is for in plain words", () => {
    const off = row({ routes: { tailscale: tailscale(false) } as CompanionState["routes"] });
    expect(off).toContain('data-settings-block="computers"');
    expect(off).toContain("Your other computers");
    expect(off).toContain("Open this computer's bots from another computer signed in to the same Tailscale account. Needs Tailscale on both.");
    expect(off).not.toContain("tailnet");
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(off).not.toContain("data-tailnet-share");
    expect(off).not.toContain("data-pairing-card");
  });

  it("says Tailscale isn't installed in the Tailscale check's own words, with where to get it", () => {
    const missing = row({ routes: { tailscale: tailscale(false) } as CompanionState["routes"], tailscaleProblem: "not-installed" });
    expect(missing).toContain('data-tailnet-trouble="not-installed"');
    expect(missing).toContain("Tailscale isn't installed on this computer.");
    expect(missing).toContain(">Get Tailscale<");
  });

  it("an organization's policy disables turning it on", () => {
    expect(row({ routes: { tailscale: tailscale(true) } as CompanionState["routes"] }, "Managed by Acme")).toMatch(/<button[^>]*disabled=""[^>]*role="switch"/);
  });

  it("shows the address, a switch that is on, and a code made for another computer, not a phone", () => {
    const on = row({ routes: { tailscale: tailscale(true, true) } as CompanionState["routes"], tailnetShare: shared });
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(on).toContain("data-tailnet-share");
    expect(on).toContain("http://macmini.tail1234.ts.net:8799");
    expect(on).toContain('data-pairing-card="computer"');
    expect(on).toContain('data-address="http://macmini.tail1234.ts.net:8799"');
  });
});

describe("turning Your other computers on", () => {
  const bridge = (tailscaleAnswer: Partial<CompanionState>) => {
    const calls: string[] = [];
    const companion = {
      state: async () => ({}) as CompanionState,
      setTailscale: async (on: boolean) => { calls.push(`tailscale:${on}`); return tailscaleAnswer as CompanionState; },
      setTailscaleComputers: async (on: boolean) => { calls.push(`computers:${on}`); return { routes: { tailscale: tailscale(true, on) } } as CompanionState; },
    } as unknown as CompanionBridge;
    return { calls, companion };
  };

  it("turns Tailscale on first, then the share", async () => {
    const { calls, companion } = bridge({ routes: { tailscale: tailscale(true) } as CompanionState["routes"] });
    const next = await setComputerShare(companion, { routes: { tailscale: tailscale(false) } as CompanionState["routes"] }, true);
    expect(calls).toEqual(["tailscale:true", "computers:true"]);
    expect(next.routes?.tailscale?.computers).toBe(true);
  });

  it("stops with Tailscale's reason when Tailscale can't be turned on", async () => {
    const { calls, companion } = bridge({ routes: { tailscale: tailscale(false) } as CompanionState["routes"], tailscaleProblem: "not-installed" });
    const next = await setComputerShare(companion, { routes: { tailscale: tailscale(false) } as CompanionState["routes"] }, true);
    expect(calls).toEqual(["tailscale:true"]);
    expect(next.tailscaleProblem).toBe("not-installed");
  });

  it("with Tailscale already on, changes only the share; turning it off leaves Tailscale on", async () => {
    const { calls, companion } = bridge({});
    await setComputerShare(companion, { routes: { tailscale: tailscale(true) } as CompanionState["routes"] }, true);
    await setComputerShare(companion, { routes: { tailscale: tailscale(true, true) } as CompanionState["routes"] }, false);
    expect(calls).toEqual(["computers:true", "computers:false"]);
  });
});
