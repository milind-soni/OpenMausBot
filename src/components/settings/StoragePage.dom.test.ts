// @vitest-environment happy-dom
// The real provider and the real Settings window in a browser tab, against a server that answers the storage route as a
// Cloud home, a person's own computer, an older Cloud or a refusal would: who gets a Storage page, and who never asks.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GB, storageReport } from "@/lib/storage-report-fixture";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const STORAGE = "/api/diagnostics/storage";
const CONFIG = {
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
  profile: { name: "Ada", email: "ada@example.com" }, features: { savedSteps: false },
  onboarding: { completedAt: "2026-01-01", version: 1, reelSeen: true, hintsSeen: [] },
  edition: { edition: "community", features: [] }, browserProfiles: [], managedPolicy: null,
  signIn: { admins: [], members: [] }, membership: { authority: "local", pairingCodes: true }, cloudHome: true,
};
const session = (scopes: string[]) => ({ kind: "session", id: "s1", label: "Chrome on Mac", email: "ada@example.com", scopes, expiresAt: 0 });
const ADMIN = session(["admin", "client"]);
const REPORT = { storage: storageReport(), now: { totalBytes: 100 * GB, freeBytes: 15 * GB, usedBytes: 85 * GB }, measureInS: 0, server: "env-a" };

let root: Root | null = null;
const requests: string[] = [];
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 25; i++) await task(); };

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
});

/** Settings opened on `section`, with the server answering `storage` (a status code for a refusal) to the storage route. */
async function openSettings({ storage, sessionAnswer = ADMIN, config = CONFIG, section = "overview", bots = [{ id: "chief", name: "Chief", threadId: "t1" }] }: {
  storage: unknown; sessionAnswer?: object; config?: object; section?: string; bots?: object[];
}) {
  vi.resetModules();
  requests.length = 0;
  FixtureEventSource.opened = [];
  const answers: Record<string, unknown> = {
    "/api/instances": { instances: [] }, "/api/config": config, "/api/auth/session": sessionAnswer,
    "/api/auth/sessions": { sessions: [{ id: "s1" }], current: "s1" }, "/api/routines": { routines: [], runs: [] },
    "/api/webhooks": { webhooks: [], attempts: [] }, "/api/bots": { bots, groups: [] },
  };
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === STORAGE && typeof storage === "number") return Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status: storage }));
    return Promise.resolve(new Response(JSON.stringify(path === STORAGE ? storage : answers[path] ?? {})));
  });
  const { StoreProvider, useStore } = await import("@/state/store");
  const { SettingsModal } = await import("../SettingsModal");
  let dispatch!: (action: never) => void;
  function Probe() {
    const store = useStore();
    dispatch = store.dispatch as never;
    return store.state.appSettingsOpen ? createElement(SettingsModal) : null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0]?.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "toggleAppSettings", open: true, section } as never));
  await settle();
}
const storageInNav = () => document.querySelector("button[data-settings-page='storage']");
const storageReads = () => requests.filter((request) => request === `GET ${STORAGE}`).length;

describe("who gets Settings → Storage", () => {
  it("an owner or admin of a Cloud home: Storage is in the list, and opens on how full it is and its largest bots", async () => {
    await openSettings({ storage: REPORT, section: "storage" });
    expect(storageInNav()?.textContent).toContain("Storage");
    expect(document.querySelector("[data-settings-page-body='storage']")).not.toBeNull();
    expect(document.querySelector("[data-storage-summary]")?.getAttribute("data-band")).toBe("near");
    expect(document.querySelector("[data-storage-bot]")?.textContent).toBe("Chief7 GB");
    // Seeing it here is what keeps the sidebar's line for this band away.
    expect(localStorage.getItem("openmausbot.storageNotice.seen.v1:server:env-a")).toBe("near");
    expect(localStorage.getItem("openmausbot.storageNotice.seen.v1")).toBeNull();
  });

  it("opening Storage reads the report and never starts a measurement", async () => {
    await openSettings({ storage: REPORT, section: "storage" });
    expect(storageReads()).toBeGreaterThan(0);
    expect(requests.filter((request) => request.startsWith("POST /api/diagnostics/storage"))).toEqual([]);
  });

  it("a Team Cloud's admin: their own MausBot keeps its name, and a bot the app isn't shown reads as a private bot", async () => {
    const answers = { ...REPORT, storage: storageReport({ bots: [{ id: "mine", bytes: 7 * GB, files: 1 }, { id: "theirs", bytes: 3 * GB, files: 1 }] }) };
    await openSettings({ storage: answers, section: "storage", config: { ...CONFIG, team: { id: "team-1", name: "Studio" } },
      bots: [{ id: "mine", name: "MausBot", threadId: "t1", defaultBot: { person: "ada@example.com" } }] });
    expect([...document.querySelectorAll("[data-storage-bot]")].map((row) => row.textContent)).toEqual(["MausBot7 GB", "Private bot3 GB", "Deleted bots1.5 GB", "Other bots512 MB"]);
  });

  it("a team member who is not an admin: no Storage page, and the route is never asked", async () => {
    await openSettings({ storage: REPORT, sessionAnswer: session(["client"]), config: { ...CONFIG, team: { id: "team-1", name: "Acme" } } });
    expect(document.querySelector("[data-settings-page-body]")).not.toBeNull();
    expect(storageInNav()).toBeNull();
    expect(storageReads()).toBe(0);
  });

  it.each([
    ["a person's own computer (no report)", { storage: null }],
    ["an older Cloud without the route", 404],
    ["a refusal", 403],
  ])("%s: no Storage page", async (_name, storage) => {
    await openSettings({ storage, section: "storage" });
    expect(storageReads()).toBe(1);
    expect(storageInNav()).toBeNull();
    expect(document.querySelector("[data-settings-page-body='storage']")).toBeNull();
  });
});
