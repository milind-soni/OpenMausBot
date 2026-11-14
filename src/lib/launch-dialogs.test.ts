import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { launchDialogShown, markLaunchDialog } from "./launch-dialogs";

let session: Map<string, string>;
beforeEach(() => {
  session = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => void session.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the first ask that opened in this launch, and only that one", () => {
  expect(launchDialogShown()).toBeNull();
  markLaunchDialog("mausbot");
  markLaunchDialog("notices");
  expect(launchDialogShown()).toBe("mausbot");
  session.clear();
  expect(launchDialogShown(), "a new launch").toBeNull();
});

it("remembers the launch's ask in memory when browser storage is blocked", () => {
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(() => markLaunchDialog("notices")).not.toThrow();
  expect(launchDialogShown()).toBe("notices");
  markLaunchDialog("mausbot");
  expect(launchDialogShown(), "the first claim still holds").toBe("notices");
});
