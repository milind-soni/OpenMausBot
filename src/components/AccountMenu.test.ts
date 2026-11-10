import { afterEach, expect, it, vi } from "vitest";
import { accountMenuItems, cloudRowLabel, switchNote } from "./AccountMenu";

afterEach(() => vi.clearAllMocks());
const actions = { signOut: vi.fn(), add: vi.fn() };
const a = { id: "a", email: "a@example.test" };

it("the You menu: just the address and Sign out, with no list of accounts", () => {
  const items = accountMenuItems({ view: { active: a }, openSheet: null, noRail: false, ...actions });
  expect(items.map((item) => item.label)).toEqual(["a@example.test", "Sign out"]);
  expect(items[0].disabled).toBe(true);
  items[1].onSelect();
  expect(actions.signOut).toHaveBeenCalledWith("a");
});

it("with no rail beside the page, its ＋ can't be reached, so Add another account stays here", () => {
  const items = accountMenuItems({ view: { active: a }, openSheet: null, noRail: true, ...actions });
  expect(items.map((item) => item.label)).toEqual(["a@example.test", "Add another account", "Sign out"]);
  items[1].onSelect();
  expect(actions.add).toHaveBeenCalledWith();
});

it("an account whose sign-in ended says so, and its tap goes to the sign-in", () => {
  const items = accountMenuItems({ view: { active: { ...a, signIn: true as const } }, openSheet: null, noRail: false, ...actions });
  expect(items[0].subtitle).toBe("Sign in again");
  expect(items[0].disabled).toBe(false);
  items[0].onSelect();
  expect(actions.add).toHaveBeenCalledWith("a@example.test");
});

it("no rows on a page that isn't offered the sheet, or while nobody is signed in here", () => {
  expect(accountMenuItems({ view: { active: null }, openSheet: null, noRail: true, ...actions })).toEqual([]);
  expect(accountMenuItems({ view: null, openSheet: null, noRail: true, ...actions })).toEqual([]);
});

it("another place's page shows no address, only the row that asks main for the sheet", () => {
  const openSheet = vi.fn();
  const items = accountMenuItems({ view: null, openSheet, noRail: false, ...actions });
  expect(items.map((item) => item.label)).toEqual(["Account and sign out"]);
  expect(JSON.stringify(items.map(({ label, subtitle, title }) => ({ label, subtitle, title })))).not.toContain("@");
  items[0].onSelect();
  expect(openSheet).toHaveBeenCalled();
});

it("what a click or sign-out that didn't go through says, in plain words", () => {
  expect(switchNote({ outcome: "moving" })).toContain("moving to the Cloud");
  expect(switchNote({ outcome: "gone" })).toContain("isn't signed in here");
  expect(switchNote({ outcome: "failed" })).toContain("Try again");
  expect(switchNote({ outcome: "switched" })).toBeNull();
  expect(switchNote({ outcome: "signed-out" })).toBeNull();
});

it("the MausBot Cloud row says Sign in while nobody is signed in here; any other page keeps its name", () => {
  expect(cloudRowLabel({ active: null })).toBe("Sign in");
  expect(cloudRowLabel({ active: { id: "b", email: "b@example.test" } })).toBe("MausBot Cloud");
  expect(cloudRowLabel(null)).toBe("MausBot Cloud");
});
