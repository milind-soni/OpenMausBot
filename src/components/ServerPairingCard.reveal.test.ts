import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// Connect your phone opens Settings with a request; the card reveals itself
// once it is drawn, once per request. React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], revealed: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("../lib/phone-pairing", () => ({ revealPhonePairing: (root: unknown) => { if (!root) return false; f.revealed.push(root); return true; } }));
import { ServerPairingCard } from "./ServerPairingCard";

const admin = { kind: "session" as const, id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 };
const REVEAL = 1; // the effect after the session read

function render(props: Parameters<typeof ServerPairingCard>[0]) {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => ServerPairingCard(props)));
  f.effects[REVEAL]!();
}
/** The card's root ref, which React would attach once the card is drawn. */
const root = () => f.values.find((value) => value && typeof value === "object" && "current" in value && (value as { current: unknown }).current === null) as { current: unknown } | undefined;

beforeEach(() => { f.values = []; f.index = 0; f.effects = []; f.revealed = []; });

it("reveals the drawn card once for each request, and never for a plain visit", () => {
  const card = { id: "card" };
  render({ initialSession: admin, focusRequest: 0 });
  root()!.current = card;
  render({ initialSession: admin, focusRequest: 0 });
  expect(f.revealed).toEqual([]);
  render({ initialSession: admin, focusRequest: 1 });
  expect(f.revealed).toEqual([card]);
  render({ initialSession: admin, focusRequest: 1 });
  expect(f.revealed).toEqual([card]);
  render({ initialSession: admin, focusRequest: 2 });
  expect(f.revealed).toEqual([card, card]);
});

it("waits for the card to be drawn before it counts the request as done", () => {
  render({ focusRequest: 1 });
  expect(f.revealed).toEqual([]);
  const card = { id: "card" };
  root()!.current = card;
  render({ focusRequest: 1 });
  expect(f.revealed).toEqual([card]);
});

it("reveals again after Settings went elsewhere and came back on a new request", () => {
  const card = { id: "card" };
  render({ initialSession: admin, focusRequest: 1 });
  root()!.current = card;
  render({ initialSession: admin, focusRequest: 1 });
  render({ initialSession: admin, focusRequest: 0 });
  render({ initialSession: admin, focusRequest: 1 });
  expect(f.revealed).toEqual([card, card]);
});
