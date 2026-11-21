// @vitest-environment happy-dom
// The real provider, its live stream and the real Settings window in a browser tab on a server (no desktop bridge), signed
// in as an admin, with every request counted by path.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { forgetSharedSession } from "@/lib/session-reuse";
import { readSharedSessionState } from "@/lib/shared-session";
import type { Action, AppState } from "@/state/store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const CONFIG = {
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
  profile: { name: "Ada", email: "ada@example.com" }, features: { savedSteps: false },
  onboarding: { completedAt: "2026-01-01", version: 1, reelSeen: true, hintsSeen: [] },
  edition: { edition: "community", features: [] }, browserProfiles: [], managedPolicy: null,
  signIn: { admins: [], members: [] }, membership: { authority: "local", pairingCodes: true },
};
const SESSION = { kind: "session", id: "s1", label: "Chrome on Mac", email: "ada@example.com", scopes: ["admin", "client"], expiresAt: 0 };
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": CONFIG,
  "/api/auth/session": SESSION,
  "/api/auth/sessions": { sessions: [{ id: "s1" }], current: "s1" },
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/bots": { bots: [], groups: [] },
};

const requests: string[] = [];
const gets = (path: string) => requests.filter((request) => request === `GET ${path}`).length;
const { StoreProvider, useStore, api } = await import("@/state/store");
const { useViewerEmail } = await import("@/lib/default-bot");
const { SettingsModal } = await import("../SettingsModal");

let seen!: AppState;
let dispatch!: (action: Action) => void;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  useViewerEmail(); // the sidebar asks who is signed in long before Settings opens
  return seen.appSettingsOpen ? createElement(SettingsModal) : null;
}
let root: Root;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await task(); };

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    requests.push(`${init?.method ?? "GET"} ${path}`);
    return Promise.resolve(new Response(JSON.stringify(answers[path] ?? {})));
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

const open = async () => {
  forgetSharedSession();
  requests.length = 0;
  flushSync(() => dispatch({ type: "toggleAppSettings", open: true, section: "overview" }));
  await settle();
  expect(document.querySelector("[data-settings-page-body='overview']")).not.toBeNull();
};
const close = async () => {
  flushSync(() => dispatch({ type: "toggleAppSettings", open: false }));
  await settle();
};

describe("opening Settings on Overview", () => {
  it("asks for the session once, and once each for what the phone row needs", async () => {
    expect(seen.config, "the store holds the config before Settings opens").not.toBeNull();
    await open();
    expect(gets("/api/auth/session")).toBe(1);
    expect(gets("/api/auth/sessions")).toBe(1);
    expect(gets("/api/config")).toBe(1);
    expect(document.querySelector("[data-glance='phone']")?.textContent).toContain("Not set up");
    await close();
  });

  it("asks again after a sign-out, never serving the session kept from before it", async () => {
    await readSharedSessionState();
    requests.length = 0;
    await readSharedSessionState();
    expect(gets("/api/auth/session"), "kept for the moment").toBe(0);
    await api("/api/auth/logout", { method: "POST" });
    answers["/api/auth/session"] = { kind: "session", id: "s2", label: "Chrome on Mac", email: "bo@example.com", scopes: ["client"], expiresAt: 0 };
    expect(await readSharedSessionState()).toMatchObject({ id: "s2", scopes: ["client"] });
    expect(gets("/api/auth/session")).toBe(1);
  });
});
