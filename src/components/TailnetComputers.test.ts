// @vitest-environment happy-dom
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
const { TailnetComputers, tailnetShareLine } = await import("./TailnetComputers");

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

describe("what the row says when nothing answers", () => {
  const sharing = { on: true, origin: null, https: false, problem: "signed-out" };

  it("with the share on and no MagicDNS name, says what to fix, not that Tailscale isn't connected", () => {
    const html = row({ routes: { tailscale: { on: true, since: 1, name: null, computers: true } } as CompanionState["routes"], tailnetShare: sharing });
    expect(html).toContain('data-tailnet-trouble="magicdns"');
    expect(html).toContain("Turn on MagicDNS in Tailscale");
    expect(html).not.toContain("isn't connected on this computer yet");
    expect(html).not.toContain("data-pairing-card");
  });

  it("says Tailscale isn't connected only when Tailscale itself gives no reason", () => {
    const html = row({ routes: { tailscale: tailscale(true, true) } as CompanionState["routes"], tailnetShare: sharing });
    expect(html).toContain("isn't connected on this computer yet");
    expect(html).not.toContain("data-tailnet-trouble");
  });

  it("says the computer is waiting for approval on the Tailscale network when that is why the switch stayed off", () => {
    const html = row({ routes: { tailscale: tailscale(false) } as CompanionState["routes"], tailscaleProblem: "needs-approval" });
    expect(html).toContain("This computer is waiting for approval on your Tailscale network. Approve it in the Tailscale admin console, then try again.");
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"/);
  });
});

describe("the switch", () => {
  it("asks the app for the share only: the app turns Tailscale on and off with it", async () => {
    const calls: string[] = [];
    const companion = { state: async () => ({}) as CompanionState, setTailscale: async () => { calls.push("tailscale"); return {} as CompanionState; }, setTailscaleComputers: async (on: boolean) => { calls.push(`computers:${on}`); return {} as CompanionState; } } as unknown as CompanionBridge;
    const act = vi.fn(async (call: (bridge: CompanionBridge) => Promise<CompanionState>) => call(companion));
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const host = document.createElement("div");
    const root = createRoot(host);
    const state = { routes: { tailscale: tailscale(false) } } as unknown as CompanionState;
    flushSync(() => root.render(createElement(TailnetComputers, { c: { busy: false, accountBusy: false, act } as unknown as PhoneSetupController, blocked: null, simple: true, state, status: deriveTailscalePairingStatus(state) })));
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    await vi.waitFor(() => expect(calls).toEqual(["computers:true"]));
    flushSync(() => root.unmount());
  });
});
