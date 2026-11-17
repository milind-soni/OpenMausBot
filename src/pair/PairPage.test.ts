import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ effects: [] as EffectCallback[], pair: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: (effect: EffectCallback) => { f.effects.push(effect); } }));
vi.mock("../lib/session", async original => ({ ...await original<typeof import("../lib/session")>(), pairWithCode: f.pair, readSessionState: vi.fn().mockResolvedValue({ kind: "unauthenticated", error: "" }) }));
vi.mock("../components/DesktopWorkspaceSwitcher", () => ({ DesktopWorkspaceSwitcher: () => null }));
import { codeProblem, codeReady, openInAppLink, PairPage, pairIntro, pairsAutomatically, pairTitle, TeamLeftPage, teamPage, unencryptedPublic } from "./PairPage";
import en from "../locales/en.json";
import type { EnvironmentDescriptor } from "../lib/session";

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
  expect(cloud).not.toContain("from the server");
  expect(pairIntro({ mode: "code", sent: false, email: "", cloudHome: false })).toContain("from the server");
  expect(pairIntro({ mode: "email", sent: true, email: "a@b.test", cloudHome: false })).toContain("a@b.test");
});

it("a team's Cloud is called by the team's name, a person's own Cloud My Cloud", () => {
  const descriptor = (capabilities: Record<string, unknown>) => ({ environmentId: "e", label: "Acme Labs", platform: "linux", version: "1", capabilities: { remoteSessions: true as const, selfUpdate: "operator" as const, ...capabilities } });
  expect(pairTitle(descriptor({ cloudHome: true, cloudTeam: true }), "code")).toBe("Acme Labs");
  expect(pairTitle(descriptor({ cloudHome: true }), "code")).toBe("My Cloud");
  expect(pairTitle(descriptor({}), "email")).toBe("Sign in to Acme Labs");
  expect(pairTitle(null, "code")).toBe("Connect to this MausBot");
});

it("names a wrong kind of code instead of letting it be sent as a wrong one", () => {
  expect(codeProblem("1234 5678")).toBe(en["serverError.pair.emailCode"]);
  expect(codeProblem("123456")).toBe(en["serverError.pair.oldCode"]);
  expect(codeProblem(`omb_sess_${"a".repeat(43)}`)).toBe(en["serverError.pair.scriptKey"]);
  expect(codeProblem("7KQ2-M9XD")).toBeNull();
  expect(codeReady("7kq2 m9xd h4tp")).toBe(true);
  expect(codeReady("1234 5678")).toBe(false);
});

it("opens the phone app at this server with the code filled in", () => {
  expect(openInAppLink("https://maus.example.com", "7kq2m9xdh4tp")).toBe("openmausbot://pair?address=https%3A%2F%2Fmaus.example.com&code=7KQ2-M9XD-H4TP");
  expect(openInAppLink("http://192.168.1.20:8799", "")).toBe("openmausbot://pair?address=http%3A%2F%2F192.168.1.20%3A8799");
});

it("warns only on plain http across the open internet", () => {
  expect(unencryptedPublic({ protocol: "http:", hostname: "203.0.113.9" })).toBe(true);
  expect(unencryptedPublic({ protocol: "http:", hostname: "192.168.1.20" })).toBe(false);
  expect(unencryptedPublic({ protocol: "https:", hostname: "maus.example.com" })).toBe(false);
});

it("asks for the code first, with email sign-in as a link below, and says how to get a code", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { replace: () => {}, protocol: "http:", hostname: "203.0.113.9", origin: "http://203.0.113.9:8799" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ environmentId: "e", label: "hetzner-1", platform: "linux", version: "1", capabilities: { emailSignIn: true } }) }));
  const html = render(code);
  expect(html).toContain(en["pair.notEncrypted"].replace("'", "&#x27;"));
  expect(html).toContain(en["pair.fromLink"]);
  expect(html).toContain("openmausbot://pair?address=http%3A%2F%2F203.0.113.9%3A8799&amp;code=ABCD-EFGH-JK23");
  expect(html).toContain("npx openmausbot pair");
  expect(html.indexOf("<form")).toBeLessThan(html.indexOf(en["pair.code"]));
});

it("a team's Cloud whose session ended offers the way back through MausBot Cloud, as the signed-in session told this browser, and only to an https page", () => {
  const team = { environmentId: "e", label: "Acme", platform: "linux", version: "1", capabilities: { remoteSessions: true as const, cloudHome: true as const, cloudTeam: true as const } } as unknown as EnvironmentDescriptor;
  expect(teamPage(team, "https://cloud.openmausbot.com/cloud/team/t1")).toBe("https://cloud.openmausbot.com/cloud/team/t1");
  expect(teamPage(team, null), "never told before sign-in").toBeNull();
  for (const bad of ["javascript:alert(1)", "http://evil.example/cloud", "https://u:p@cloud.example/x", "https://cloud.example/x#signin=1", "nope"]) expect(teamPage(team, bad)).toBeNull();
  expect(teamPage({ ...team, capabilities: { remoteSessions: true, cloudHome: true } } as unknown as EnvironmentDescriptor, "https://cloud.openmausbot.com/cloud/team/t1"), "a My Cloud has no team page").toBeNull();
  expect(en["pair.team.open"].replace("{team}", "Acme")).toBe("Open Acme with MausBot Cloud");
});

it("a team's page whose person is no longer in the team says so in one sentence, with nothing to sign in to", () => {
  const html = renderToStaticMarkup(createElement(TeamLeftPage, { team: "Acme" }));
  expect(html).toContain("You&#x27;re no longer in Acme.");
  expect(html).not.toMatch(/<(input|button|a) /);
});
