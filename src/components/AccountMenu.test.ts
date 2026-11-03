import { afterEach, expect, it, vi } from "vitest";
import { accountMenuItems, switchNote } from "./AccountMenu";

afterEach(() => vi.clearAllMocks());
const actions = { switchTo: vi.fn(), signOut: vi.fn(), add: vi.fn() };
const a = { id: "a", email: "a@example.test" }, b = { id: "b", email: "b@example.test" }, c = { id: "c", email: "c@example.test" };

it("one account: just its address, Add another account and Sign out", () => {
  const items = accountMenuItems({ view: { active: a, others: [] }, openSheet: null, ...actions });
  expect(items.map((item) => item.label)).toEqual(["a@example.test", "Add another account", "Sign out"]);
  items[2].onSelect();
  expect(actions.signOut).toHaveBeenCalledWith("a");
  items[1].onSelect();
  expect(actions.add).toHaveBeenCalledWith();
});

it("three accounts: each other one is a tap away", () => {
  const items = accountMenuItems({ view: { active: a, others: [b, c] }, openSheet: null, ...actions });
  expect(items.map((item) => item.label)).toEqual(["a@example.test", "b@example.test", "c@example.test", "Add another account", "Sign out"]);
  expect(items[0].disabled).toBe(true);
  items[2].onSelect();
  expect(actions.switchTo).toHaveBeenCalledWith(c);
});

it("an account whose sign-in ended says so, and its tap goes to the sign-in", () => {
  const ended = { ...a, signIn: true as const };
  const items = accountMenuItems({ view: { active: ended, others: [{ ...b, signIn: true }] }, openSheet: null, ...actions });
  expect(items[0].subtitle).toBe("Sign in again");
  expect(items[0].disabled).toBe(false);
  items[0].onSelect();
  expect(actions.add).toHaveBeenCalledWith("a@example.test");
  expect(items[1].subtitle).toBe("Sign in again");
});

it("no rows on a page that isn't offered the sheet, or while nobody is signed in here", () => {
  expect(accountMenuItems({ view: { active: null, others: [] }, openSheet: null, ...actions })).toEqual([]);
  expect(accountMenuItems({ view: null, openSheet: null, ...actions })).toEqual([]);
});

it("another place's page shows no address, only the row that asks main for the sheet", () => {
  const openSheet = vi.fn();
  const items = accountMenuItems({ view: null, openSheet, ...actions });
  expect(items.map((item) => item.label)).toEqual(["Account and sign out"]);
  expect(JSON.stringify(items.map(({ label, subtitle, title }) => ({ label, subtitle, title })))).not.toContain("@");
  items[0].onSelect();
  expect(openSheet).toHaveBeenCalled();
});

it("what a switch that didn't go through says, in plain words", () => {
  expect(switchNote({ outcome: "moving" })).toContain("moving to the Cloud");
  expect(switchNote({ outcome: "gone" })).toContain("isn't signed in here");
  expect(switchNote({ outcome: "failed" })).toContain("Try again");
  expect(switchNote({ outcome: "switched" })).toBeNull();
  expect(switchNote({ outcome: "signed-out" })).toBeNull();
});
