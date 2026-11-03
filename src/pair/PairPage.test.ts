import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ effects: [] as EffectCallback[], pair: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: (effect: EffectCallback) => { f.effects.push(effect); } }));
vi.mock("../lib/session", async original => ({ ...await original<typeof import("../lib/session")>(), pairWithCode: f.pair, readSessionState: vi.fn().mockResolvedValue({ kind: "unauthenticated", error: "" }) }));
vi.mock("../components/DesktopWorkspaceSwitcher", () => ({ DesktopWorkspaceSwitcher: () => null }));
import { PairPage, pairIntro, pairsAutomatically, pairTitle } from "./PairPage";
import en from "../locales/en.json";

const code = "ABCD-EFGH-JK23";
const render = (initialCode: string | null) => { f.effects = []; return renderToStaticMarkup(createElement(PairPage, { initialCode })); };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
let replaced: string[];
beforeEach(() => {
  f.pair.mockReset(); replaced = [];
  vi.stubGlobal("location", { replace: (url: string) => replaced.push(url) });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});
afterEach(() => vi.unstubAllGlobals());

it("in the desktop app, a code the link carried connects at once; a browser still asks", () => {
  expect(pairsAutomatically(code, true)).toBe(true);
  expect(pairsAutomatically(code, false)).toBe(false);
  expect(pairsAutomatically(null, true)).toBe(false);
});

it("opening My Cloud from the app needs no click and no code to type", async () => {
  vi.stubGlobal("window", { ogb: { workspaces: {} } });
  f.pair.mockResolvedValue({ ok: true });
  const html = render(code);
  expect(html).toContain("Connecting to this MausBot…");
  expect(html).not.toContain("Pairing code"); expect(html).not.toContain("<form");
  f.effects[0](); await flush();
  expect(f.pair).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code }));
  expect(replaced).toEqual(["/"]);
});

it("a code that no longer works falls back to the form, with the reason", async () => {
  vi.stubGlobal("window", { ogb: { workspaces: {} } });
  f.pair.mockResolvedValue({ ok: false, error: "That pairing code has expired." });
  render(code); f.effects[0](); await flush();
  expect(replaced).toEqual([]);
});

it("a browser keeps the code in the form for the person to confirm", () => {
  vi.stubGlobal("window", {});
  const html = render(code);
  expect(html).toContain(`value="${code}"`); expect(html).toContain(">Connect</button>");
  f.effects[0]?.(); expect(f.pair).not.toHaveBeenCalled();
});

it("My Cloud says where its connection starts, never 'the code shown on the server'", () => {
  const cloud = pairIntro({ mode: "code", sent: false, email: "", cloudHome: true });
  expect(cloud).toContain(`choose ${en["cloudHome.connect"]} in the MausBot app`);
  expect(cloud).toContain(`Settings → ${en["settings.section.cloudAccount"]}`);
  expect(cloud).toContain("on your Plan page");
  expect(cloud).not.toContain("shown on the server");
  expect(pairIntro({ mode: "code", sent: false, email: "", cloudHome: false })).toContain("shown on the server");
  expect(pairIntro({ mode: "email", sent: true, email: "a@b.test", cloudHome: false })).toContain("a@b.test");
});

it("a team's Cloud is called by the team's name, a person's own Cloud My Cloud", () => {
  const descriptor = (capabilities: Record<string, unknown>) => ({ environmentId: "e", label: "Acme Labs", platform: "linux", version: "1", capabilities: { remoteSessions: true as const, selfUpdate: "operator" as const, ...capabilities } });
  expect(pairTitle(descriptor({ cloudHome: true, cloudTeam: true }), "code")).toBe("Acme Labs");
  expect(pairTitle(descriptor({ cloudHome: true }), "code")).toBe("My Cloud");
  expect(pairTitle(descriptor({}), "email")).toBe("Sign in to Acme Labs");
  expect(pairTitle(null, "code")).toBe("Connect to this MausBot");
});
