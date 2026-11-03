import { afterEach, expect, it, vi } from "vitest";
import { accountMenuItems, cloudRowLabel } from "./AccountMenu";

afterEach(() => vi.unstubAllGlobals());
const signOut = vi.fn();

it("one account: its address, then Sign out", () => {
  const items = accountMenuItems({ view: { active: { id: "a", email: "a@example.test" }, others: [] }, openSheet: null, signOut });
  expect(items.map((item) => item.label)).toEqual(["a@example.test", "Sign out"]);
  items[1].onSelect();
  expect(signOut).toHaveBeenCalledWith("a");
});

it("signed out, or a page that isn't offered the sheet: no rows", () => {
  expect(accountMenuItems({ view: { active: null, others: [] }, openSheet: null, signOut })).toEqual([]);
  expect(accountMenuItems({ view: null, openSheet: null, signOut })).toEqual([]);
});

it("another place's page shows no address, only the row that asks main for the sheet", () => {
  const openSheet = vi.fn();
  const items = accountMenuItems({ view: null, openSheet, signOut });
  expect(items.map((item) => item.label)).toEqual(["Account and sign out"]);
  expect(JSON.stringify(items)).not.toContain("@");
  items[0].onSelect();
  expect(openSheet).toHaveBeenCalled();
});

it("the MausBot Cloud row says Sign in while nobody is signed in here; any other page keeps its name", () => {
  expect(cloudRowLabel({ active: null, others: [] })).toBe("Sign in");
  expect(cloudRowLabel({ active: { id: "b", email: "b@example.test" }, others: [] })).toBe("MausBot Cloud");
  expect(cloudRowLabel(null)).toBe("MausBot Cloud");
});
