import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("a navigation retires the launch recovery, except the recovery's own", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function navigateMainWindow(");
  assert.ok(start > 0);
  const end = source.indexOf("\n}\n", start) + 3;
  const calls = [];
  const context = vm.createContext({
    homeWindow: { cancel: () => calls.push("cancel") },
    mainWindow: { isDestroyed: () => false, loadURL: async (url) => { calls.push(`load:${url}`); } },
  });
  vm.runInContext(`${source.slice(start, end)}; this.navigateMainWindow = navigateMainWindow;`, context);
  await context.navigateMainWindow("https://studio.example.test/");
  assert.deepEqual(calls, ["cancel", "load:https://studio.example.test/"], "a place opened on purpose takes the window back");
  calls.length = 0;
  await context.navigateMainWindow("https://garage.example.test/", true);
  assert.deepEqual(calls, ["load:https://garage.example.test/"], "the recovery's own way back is not a choice");
});
