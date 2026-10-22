import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSendNotice, CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudSendStrip } from "./CloudSendStrip";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deep = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(deep)];
};
const text = (node: Node): string => Children.toArray(node.props.children).map((child) => isValidElement(child) ? text(child as Node) : String(child)).join("");
const html = (component: () => ReactNode) => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(component)).replaceAll("&#x27;", "'"); };
const tree = (component: () => ReactNode) => { f.index = 0; f.effects = []; return deep(component()); };
const button = (component: () => ReactNode, label: string) => tree(component).find((node) => node.type === "button" && text(node) === label);

const counts = { bots: 0, updatedBots: 0, skills: 0, logins: 0, onePassword: false, settings: 0, chats: null };
const notice: CloudSendNotice = { ready: true, bots: ["Ember"], updatedBots: [], skills: 2, logins: 0, onePassword: true, settings: 0, signature: "sig-1", dismissed: false, running: false, last: null, whole: null };
let page: CloudSendPageBridge;
const strip = (cloudHome = true, onPairPhone?: () => void) => () => CloudSendStrip({ cloudHome, onPairPhone });
async function shown(value: CloudSendNotice, cloudHome = true) {
  page = { notice: vi.fn().mockResolvedValue(value), dismiss: vi.fn().mockResolvedValue({ ...value, move: undefined }), onNotice: vi.fn(() => () => {}) };
  vi.stubGlobal("window", { ogb: { cloudSendPage: page } });
  html(strip(cloudHome)); for (const effect of f.effects) effect(); await flush();
}

beforeEach(() => { f.values = []; f.index = 0; f.effects = []; setLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("says nothing without the one-time move, whatever an older desktop's send did", async () => {
  await shown(notice);
  expect(html(strip())).toBe("");
  f.values = [];
  await shown({ ...notice, running: true, runningReason: "first", last: { at: 3, reason: "first", failed: 2, seen: false, sent: { ...counts, bots: 2 },
    reasons: [{ what: { bots: [], skills: 0, logins: 2, onePassword: false, settings: 0, chats: false }, error: "OpenMausBot on this computer did not answer." }] } });
  expect(html(strip())).toBe("");
});

it("shows the move on its way on either page, with nothing to press", async () => {
  await shown({ ...notice, move: { phase: "copy", chats: { done: 34, total: 120 } } });
  expect(html(strip())).toContain("Bringing this computer's bots to My Cloud… 34 of 120 chats");
  expect(tree(strip()).some((node) => node.type === "button")).toBe(false);
  f.values = [];
  await shown({ ...notice, move: { phase: "wait", waitingFor: "Scout" } }, false);
  expect(html(strip(false))).toContain("Moving your bots to My Cloud… waiting for Scout to finish");
  expect(tree(strip(false)).some((node) => node.type === "button")).toBe(false);
});

it("after a day of failing offers the move's own Try again", async () => {
  await shown({ ...notice, move: { phase: "copy", failing: { error: "My Cloud did not answer." } } }, false);
  page.moveRetry = vi.fn().mockResolvedValue({ ...notice, move: { phase: "finishing" } });
  button(strip(false), "Try again")!.props.onClick!(); await flush();
  expect(page.moveRetry).toHaveBeenCalledTimes(1);
  expect(html(strip(false))).toContain("Moving to My Cloud… almost done");
});

it("a failing move My Cloud refused by a serverError key says why in the page's language; any other key, or none, shows main's English", async () => {
  const english = "Moving a computer's bots, chats and logins goes to My Cloud only. Nothing personal comes into Acme.";
  setLocale("pt-br");
  await shown({ ...notice, move: { phase: "copy", failing: { error: english, errorKey: "serverError.team.personalMove", errorParams: { team: "Acme" } } } }, false);
  expect(html(strip(false))).toContain("Seus bots ainda não conseguiram ir para o Cloud: Os bots, as conversas e os logins de um computador só podem ir para o Cloud. Nada pessoal entra em Acme.");
  for (const failing of [{ error: english, errorKey: "cloudHome.connect", errorParams: {} }, { error: english }]) {
    f.values = [];
    await shown({ ...notice, move: { phase: "copy", failing } }, false);
    expect(html(strip(false))).toContain(`Seus bots ainda não conseguiram ir para o Cloud: ${english}`);
  }
});

it("My Cloud's page says once what arrived, with the phone to pair, until closed", async () => {
  const pair = vi.fn();
  await shown({ ...notice, move: { phase: "done", counts: { bots: 4, skills: 2, logins: 2, onePassword: true, chats: 148, routines: 2 }, phone: true, held: [] } });
  expect(html(strip(true, pair))).toContain("Everything from this computer is here: 4 bots, 2 skills, 2 logins, 1Password, 148 chats, and 2 routines.");
  button(strip(true, pair), "Pair your phone with My Cloud")!.props.onClick!();
  expect(pair).toHaveBeenCalledTimes(1);
  button(strip(true, pair), "Close")!.props.onClick!(); await flush();
  expect(page.dismiss).toHaveBeenCalledWith("one-home");
  expect(html(strip(true, pair))).toBe("");
});
