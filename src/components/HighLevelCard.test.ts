// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { HighLevelStatus } from "@/lib/highlevel-sign-in";

const fixture = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return { api: vi.fn() };
});
vi.mock("@/state/store", () => ({ api: fixture.api }));

import { HighLevelCard } from "./HighLevelCard";
import { forgetHighLevelStatus, preloadHighLevelStatus } from "@/lib/highlevel-status";

const flow = { flowId: "flow-1", authorizationUrl: "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation?state=abc", expiresAt: "2026-10-15T12:10:00Z" };
const connectedStatus: HighLevelStatus = { state: "connected", kind: "oauth", location: { id: "loc_1", name: "Example Profiles" } };

interface Server {
  status: HighLevelStatus;
  polls: Array<{ phase: string; message?: string }>;
  calls: Array<[string, string, unknown]>;
}
let server: Server;
let host: HTMLDivElement;
let root: Root;
let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<boolean>>>;
let onConnection: ReturnType<typeof vi.fn<(connected: boolean | null) => void>>;

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
const card = () => host.querySelector<HTMLElement>('[data-app-tile="highlevel"]');
const buttons = () => [...host.querySelectorAll("button")];
const button = (label: string) => buttons().find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
const text = () => card()?.textContent ?? "";

function serve() {
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    server.calls.push([method, path, body]);
    if (path === "/api/highlevel" && method === "GET") return server.status;
    if (path === "/api/highlevel" && method === "DELETE") { server.status = { state: "signed-out" }; return { ok: true }; }
    if (path === "/api/highlevel/sign-in" && method === "POST") { server.status = { state: "connecting", flow }; return flow; }
    if (path === `/api/highlevel/sign-in/${flow.flowId}` && method === "GET") {
      const next = server.polls.shift() ?? { phase: "waiting" };
      if (next.phase === "connected") server.status = connectedStatus;
      return next;
    }
    if (path === `/api/highlevel/sign-in/${flow.flowId}` && method === "DELETE") { server.status = { state: "signed-out" }; return { ok: true }; }
    if (path === "/api/highlevel/token" && method === "POST") { server.status = { ...connectedStatus, kind: "token" }; return { ok: true }; }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

async function mount(status: HighLevelStatus) {
  server = { status, polls: [], calls: [] };
  serve();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(HighLevelCard, { onConnection })));
  await settle();
}

const poll = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  setLocale("en");
  forgetHighLevelStatus();
  fixture.api.mockReset();
  openExternal = vi.fn<(url: string) => Promise<boolean>>(async () => true);
  onConnection = vi.fn<(connected: boolean | null) => void>();
  window.confirm = vi.fn(() => true);
  (window as unknown as { ogb: unknown }).ogb = { openExternal };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("HighLevel card states", () => {
  it("offers Connect with the CRM subtitle when signed out, and no token field until asked", async () => {
    await mount({ state: "signed-out" });
    expect(card()?.dataset.highlevelState).toBe("signed-out");
    expect(text()).toContain("HighLevel");
    expect(text()).toContain("Also Growably and other HighLevel-based CRMs.");
    expect(button("Connect HighLevel")).toBeTruthy();
    expect(button("Use a Private Integration token instead")).toBeTruthy();
    expect(host.querySelector("input")).toBeNull();
    expect(text()).not.toMatch(/OAuth/);
    expect(onConnection).toHaveBeenLastCalledWith(false);
  });

  it("shows the location's name once connected, with a menu instead of a Connect button", async () => {
    await mount(connectedStatus);
    expect(text()).toContain("Connected · Example Profiles");
    expect(button("Connect HighLevel")).toBeUndefined();
    expect(button("HighLevel options")).toBeTruthy();
    expect(host.querySelector('[aria-label="Connected"]')).toBeTruthy();
    expect(onConnection).toHaveBeenLastCalledWith(true);
  });

  it("says it is signed out and offers Reconnect when the server lost the connection", async () => {
    await mount({ state: "needs-sign-in", location: { id: "loc_1", name: "Example Profiles" } });
    expect(text()).toContain("Signed out. Reconnect to keep using it.");
    expect(button("Reconnect HighLevel")?.textContent).toBe("Reconnect");
    expect(button("HighLevel options")).toBeTruthy();
    expect(onConnection).toHaveBeenLastCalledWith(false);
  });

  it("follows a sign-in the server already has, with Cancel and the finish-in-browser line", async () => {
    await mount({ state: "connecting", flow });
    expect(text()).toContain("Finish signing in to HighLevel in your browser.");
    expect(button("Cancel")).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
    server.polls.push({ phase: "connected" });
    await poll();
    expect(text()).toContain("Connected · Example Profiles");
  });

  it("draws nothing when the server has no relay", async () => {
    await mount({ state: "unavailable" });
    expect(card()).toBeNull();
    expect(onConnection).toHaveBeenLastCalledWith(false);
  });
});

describe("Connecting HighLevel", () => {
  it("starts the flow, opens HighLevel's page, polls, and lands on connected", async () => {
    await mount({ state: "signed-out" });
    await act(async () => button("Connect HighLevel")!.click());
    await settle();
    expect(server.calls).toContainEqual(["POST", "/api/highlevel/sign-in", undefined]);
    expect(openExternal).toHaveBeenCalledWith(flow.authorizationUrl);
    expect(text()).toContain("Finish signing in to HighLevel in your browser.");
    expect(button("Cancel")).toBeTruthy();
    expect(server.calls.filter(([method, path]) => method === "GET" && path === `/api/highlevel/sign-in/${flow.flowId}`)).toHaveLength(0);

    await poll();
    expect(server.calls.filter(([method, path]) => method === "GET" && path === `/api/highlevel/sign-in/${flow.flowId}`)).toHaveLength(1);
    expect(text()).toContain("Finish signing in to HighLevel in your browser.");

    server.polls.push({ phase: "connected" });
    await poll();
    expect(text()).toContain("Connected · Example Profiles");
    expect(button("Cancel")).toBeUndefined();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(onConnection).toHaveBeenLastCalledWith(true);
    expect(await preloadHighLevelStatus()).toEqual(connectedStatus);
  });

  it("cancels on the server and returns to Connect when the person cancels", async () => {
    await mount({ state: "signed-out" });
    await act(async () => button("Connect HighLevel")!.click());
    await settle();
    await act(async () => button("Cancel")!.click());
    await settle();
    expect(server.calls).toContainEqual(["DELETE", `/api/highlevel/sign-in/${flow.flowId}`, undefined]);
    expect(button("Connect HighLevel")).toBeTruthy();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await poll();
    expect(server.calls.filter(([method, path]) => method === "GET" && path === `/api/highlevel/sign-in/${flow.flowId}`)).toHaveLength(0);
  });

  it("shows the server's reason in one line when the sign-in fails", async () => {
    await mount({ state: "signed-out" });
    await act(async () => button("Connect HighLevel")!.click());
    await settle();
    server.polls.push({ phase: "failed", message: "HighLevel refused the sign-in." });
    server.status = { state: "signed-out" };
    await poll();
    expect([...host.querySelectorAll('[role="alert"]')].map((element) => element.textContent)).toEqual(["HighLevel refused the sign-in."]);
    expect(button("Connect HighLevel")).toBeTruthy();
  });

  it("reconnects through the same flow from the signed-out state", async () => {
    await mount({ state: "needs-sign-in", location: { id: "loc_1", name: "Example Profiles" } });
    await act(async () => button("Reconnect HighLevel")!.click());
    await settle();
    expect(server.calls).toContainEqual(["POST", "/api/highlevel/sign-in", undefined]);
    expect(openExternal).toHaveBeenCalledWith(flow.authorizationUrl);
    server.polls.push({ phase: "connected" });
    await poll();
    expect(text()).toContain("Connected · Example Profiles");
  });
});

describe("Private Integration token", () => {
  it("reveals the two fields with one line of help and posts token and location", async () => {
    await mount({ state: "signed-out" });
    await act(async () => button("Use a Private Integration token instead")!.click());
    await settle();
    const tokenField = host.querySelector<HTMLInputElement>('input[aria-label="Private Integration token"]')!;
    const locationField = host.querySelector<HTMLInputElement>('input[aria-label="Location ID"]')!;
    expect(tokenField.type).toBe("password");
    expect(text()).toContain("go to Settings → Private Integrations");
    // The one permission the token check itself needs, and the one contact reads use to name custom fields.
    expect(text()).toMatch(/permissions: View Locations, View Contacts, Edit Contacts, View Opportunities, Edit Opportunities and View Custom Fields/u);

    await act(async () => host.querySelector<HTMLButtonElement>('form[data-highlevel-token-form] button[type="submit"]')!.click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Paste the token and the location ID.");
    expect(server.calls.some(([, path]) => path === "/api/highlevel/token")).toBe(false);

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      nativeInputValueSetter.call(tokenField, " pit-abc ");
      tokenField.dispatchEvent(new Event("input", { bubbles: true }));
      nativeInputValueSetter.call(locationField, "loc_1");
      locationField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('form[data-highlevel-token-form] button[type="submit"]')!.click());
    await settle();
    expect(server.calls).toContainEqual(["POST", "/api/highlevel/token", { token: "pit-abc", locationId: "loc_1" }]);
    expect(text()).toContain("Connected · Example Profiles");
    expect(host.querySelector("input")).toBeNull();
  });

  it("keeps the token out of the card and shows the server's refusal", async () => {
    await mount({ state: "signed-out" });
    await act(async () => button("Use a Private Integration token instead")!.click());
    await settle();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const [tokenField, locationField] = [...host.querySelectorAll("input")];
    await act(async () => {
      setter.call(tokenField, "pit-secret");
      tokenField!.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(locationField, "loc_x");
      locationField!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const refusal = "This token does not belong to that location (403): it was created in another sub-account or at the agency level. Create the Private Integration inside the sub-account whose location ID you entered.";
    fixture.api.mockImplementationOnce(async () => { throw new Error(refusal); });
    await act(async () => host.querySelector<HTMLButtonElement>('form[data-highlevel-token-form] button[type="submit"]')!.click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(refusal);
    // The field keeps what was typed so it can be corrected, masked; nothing else in the card repeats it.
    expect(tokenField!.type).toBe("password");
    expect(text()).not.toContain("pit-secret");
    expect(button("Connect HighLevel")).toBeTruthy();
  });
});

describe("Disconnecting HighLevel", () => {
  it("asks first, then removes the connection and returns to Connect", async () => {
    await mount(connectedStatus);
    await act(async () => button("HighLevel options")!.click());
    await settle();
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"][data-menu-key="disconnect"]')!;
    expect(item.textContent).toContain("Disconnect");
    await act(async () => item.click());
    await settle();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Disconnect HighLevel?"));
    expect(server.calls).toContainEqual(["DELETE", "/api/highlevel", undefined]);
    expect(button("Connect HighLevel")).toBeTruthy();
    expect(onConnection).toHaveBeenLastCalledWith(false);
  });

  it("does nothing when the person declines", async () => {
    await mount(connectedStatus);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => button("HighLevel options")!.click());
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"][data-menu-key="disconnect"]')!.click());
    await settle();
    expect(server.calls.some(([method, path]) => method === "DELETE" && path === "/api/highlevel")).toBe(false);
    expect(text()).toContain("Connected · Example Profiles");
  });
});
