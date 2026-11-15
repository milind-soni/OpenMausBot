import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";
import { TailnetComputers, tailnetShareLine } from "./TailnetComputers";

vi.mock("../lib/session", async (original) => ({ ...await original<typeof import("../lib/session")>(), readSessionState: async () => ({ kind: "loopback" }) }));

const controller = { busy: false, accountBusy: false, act: async () => {} } as unknown as PhoneSetupController;
const row = (computers: boolean, tailnetShare?: CompanionState["tailnetShare"], blocked: string | null = null) => renderToStaticMarkup(createElement(TailnetComputers, {
  c: controller, blocked, simple: true,
  state: { routes: { tailscale: { on: true, since: 1, name: "macmini.tail1234.ts.net", computers } }, tailnetShare } as unknown as CompanionState,
}));

const off = { on: false, origin: null, https: false, problem: null };

describe("the line under Your other computers", () => {
  it("says nothing while the share is off", () => {
    expect(tailnetShareLine(undefined)).toBeNull();
    expect(tailnetShareLine(off)).toBeNull();
  });

  it("names the exact address another computer opens, and how it is protected", () => {
    const https = tailnetShareLine({ on: true, origin: "https://macmini.tail1234.ts.net", https: true, problem: null });
    expect(https).toContain("https://macmini.tail1234.ts.net");
    expect(https).toContain("HTTPS certificate");
    const http = tailnetShareLine({ on: true, origin: "http://macmini.tail1234.ts.net:8799", https: false, problem: null });
    expect(http).toContain("http://macmini.tail1234.ts.net:8799");
    expect(http).toContain("WireGuard");
  });

  it("says Tailscale isn't connected while nothing answers", () => {
    expect(tailnetShareLine({ on: true, origin: null, https: false, problem: "not-listening" })).toContain("isn't connected");
  });
});

describe("the row under the Tailscale route", () => {
  it("is off with a Turn on button until the person chooses, and an organization's policy disables it", () => {
    const off = row(false);
    expect(off).toContain("Turn on");
    expect(off).not.toContain("data-tailnet-share");
    expect(row(false, undefined, "Managed by Acme")).toContain("disabled");
  });

  it("shows the address and Turn off once it is on", () => {
    const on = row(true, { on: true, origin: "http://macmini.tail1234.ts.net:8799", https: false, problem: null });
    expect(on).toContain("Turn off");
    expect(on).toContain("data-tailnet-share");
    expect(on).toContain("http://macmini.tail1234.ts.net:8799");
  });
});
