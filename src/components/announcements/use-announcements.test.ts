// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { TEAMS_NOTICE } from "@/lib/notices";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), session: {} as Record<string, unknown>, cards: [] as unknown[] }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: f.state, dispatch: f.dispatch }),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/auth/session") return f.session;
    if (path === "/api/announcements") return { cards: f.cards, updatedAt: "2026-11-11T00:00:00Z" };
    if (path === "/api/config" && init?.method === "PUT") return { ...(f.state.config as object), onboarding: JSON.parse(String(init.body)).onboarding };
    if (path === "/api/me/welcome") return { welcome: {} };
    return f.state.config;
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const { useAnnouncements } = await import("./use-announcements");
const { forgetAnnouncementCards } = await import("@/lib/announcements");
const { api } = await import("@/state/store");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let found: ReturnType<typeof useAnnouncements>;
function Probe() { found = useAnnouncements(() => Date.parse("2026-11-18T10:00:00Z")); return null; }
const mount = async () => {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Probe)); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
};
const config = (hintsSeen: string[], extra: Record<string, unknown> = {}) => ({ onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen }, ...extra });

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), clear: () => storage.clear() });
  forgetAnnouncementCards(); vi.clearAllMocks(); f.cards = [];
  f.session = { hosted: true, scopes: ["admin"] };
  f.state = { connected: true, bots: [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }], groups: [], routines: [], routinesLoadState: "ready", config: config([]) };
  f.dispatch.mockImplementation((action: { type: string; config?: unknown }) => { if (action.type === "configStatus") f.state = { ...f.state, config: action.config }; });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host?.remove(); vi.unstubAllGlobals(); });

it("someone who used the app before has the dot for Teams alone, and opening Announcements clears it here and in their record", async () => {
  await mount();
  expect(found.items[0]?.id).toBe(TEAMS_NOTICE);
  expect(found.unread).toBe(true);
  await act(async () => { found.markRead(); await Promise.resolve(); });
  expect(found.unread).toBe(false);
  const put = vi.mocked(api).mock.calls.find(([path, init]) => path === "/api/config" && (init as RequestInit | undefined)?.method === "PUT");
  expect(JSON.parse(String((put![1] as RequestInit).body)).onboarding.hintsSeen).toEqual([`announcements-read-${Date.parse("2026-11-18T10:00:00Z")}`]);
  localStorage.clear();
  await act(async () => { root!.render(createElement(Probe)); });
  expect(found.unread, "the place's record keeps it for their other devices").toBe(false);
});

it("no dot once the Teams popup was seen, nor before the session is known", async () => {
  f.state = { ...f.state, config: config([TEAMS_NOTICE]) };
  await mount();
  expect(found.unread).toBe(false);
  await act(async () => root?.unmount());
  f.session = new Promise(() => {}) as never;
  f.state = { ...f.state, config: config([]) };
  await mount();
  expect(found.unread, "waits for who is looking").toBe(false);
});

it("a Team Cloud's member: Teams is theirs, the dot too, and clearing it writes their own record", async () => {
  f.session = { hosted: true, scopes: ["client"], team: { role: "member" } };
  f.state = { ...f.state, config: config([], { team: { id: "t", name: "Acme" }, cloudHome: true }) };
  await mount();
  expect(found.items.map(item => item.id)).toEqual([TEAMS_NOTICE]);
  expect(found.unread).toBe(true);
  await act(async () => { found.markRead(); await Promise.resolve(); });
  expect(vi.mocked(api).mock.calls.some(([path]) => path === "/api/me/welcome")).toBe(true);
  expect(vi.mocked(api).mock.calls.some(([path, init]) => path === "/api/config" && (init as RequestInit | undefined)?.method === "PUT"), "never the team's record").toBe(false);
  expect(found.unread).toBe(false);
});
