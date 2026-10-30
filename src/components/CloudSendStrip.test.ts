import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSendNotice, CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import type { OneHomeView } from "../../electron/one-home.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudSendStrip } from "./CloudSendStrip";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const html = (component: () => ReactNode) => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(component)).replaceAll("&#x27;", "'"); };

const notice: CloudSendNotice = { ready: true, bots: ["Ember"], updatedBots: [], skills: 2, logins: 0, onePassword: true, settings: 0, signature: "sig-1", dismissed: false, running: false, last: null, whole: null };
const strip = (cloudHome: boolean) => () => CloudSendStrip({ cloudHome });
async function shown(value: CloudSendNotice, cloudHome: boolean) {
  const page: CloudSendPageBridge = { notice: vi.fn().mockResolvedValue(value), dismiss: vi.fn().mockResolvedValue({ ...value, move: undefined }), onNotice: vi.fn(() => () => {}) };
  vi.stubGlobal("window", { ogb: { cloudSendPage: page } });
  html(strip(cloudHome)); for (const effect of f.effects) effect(); await flush();
}

beforeEach(() => { f.values = []; f.index = 0; f.effects = []; setLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); });

// Every state of the one-time move; its words live in the account area at the bottom of the sidebar (AccountMove).
const moves: OneHomeView[] = [
  { phase: "copy" },
  { phase: "copy", chats: { done: 34, total: 120 } },
  { phase: "copy", updating: true },
  { phase: "copy", failing: { error: "Some of this computer's things did not reach My Cloud." } },
  { phase: "wait", waitingFor: "Scout" },
  { phase: "wait", waitingFor: "", waitingWhat: "sign-in" },
  { phase: "wait", failing: { error: null } },
  { phase: "finishing" },
  { phase: "finishing", failing: { error: "My Cloud did not answer." } },
  { phase: "done", counts: { bots: 4, skills: 2, logins: 2, onePassword: true, chats: 148, routines: 2 }, phone: true, held: ["OPENAI_API_KEY"] },
  { phase: "keeping" },
  { phase: "keeping", updating: true },
  { phase: "home-again" },
  { phase: "back" },
  { phase: "back", lost: true },
  { phase: "back", elsewhere: { name: "Ada's MacBook", since: 1_760_000_000_000 } },
  { phase: "back", kept: true },
];

it("never draws the one-time move over the page, on either page, in any state", async () => {
  for (const move of moves) {
    for (const cloudHome of [false, true]) {
      f.values = [];
      await shown({ ...notice, move }, cloudHome);
      expect(html(strip(cloudHome)), `${move.phase} ${JSON.stringify(move)} on ${cloudHome ? "My Cloud" : "this computer"}`).toBe("");
    }
  }
});

it("says nothing without a move, whatever an older desktop's send did, nor in a browser", async () => {
  await shown({ ...notice, running: true, runningReason: "first", last: { at: 3, reason: "first", failed: 2, seen: false, sent: { bots: 2, updatedBots: 0, skills: 0, logins: 0, onePassword: false, settings: 0, chats: null },
    reasons: [{ what: { bots: [], skills: 0, logins: 2, onePassword: false, settings: 0, chats: false }, error: "OpenMausBot on this computer did not answer." }] } }, true);
  expect(html(strip(true))).toBe("");
  f.values = [];
  vi.stubGlobal("window", {});
  expect(html(strip(true))).toBe("");
});

it("still shows a bot's move into a team on My Cloud's page while the one-time move has its own line", async () => {
  await shown({ ...notice, move: { phase: "done", phone: false, held: [] }, teamMove: { bot: { id: "scout", name: "Scout" }, team: { id: "team-acme", name: "Acme" }, phase: "moving" } }, true);
  expect(html(strip(true))).toContain("Moving Scout to Acme…");
  expect(html(strip(true))).not.toContain("Everything from this computer is here");
});
