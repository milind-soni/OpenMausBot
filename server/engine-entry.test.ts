import { expect, it } from "vitest";
import type { InstanceConfigMap } from "./contracts.ts";
import { keepsLoadedEngine, sameEngineEntry } from "./engine-entry.ts";

const entry = (over: Partial<InstanceConfigMap[string]> = {}): InstanceConfigMap[string] =>
  ({ driver: "claudeAgent", displayName: "Claude", enabled: true, config: { cli: "/bin/claude" }, ...over });

it("treats entries that differ only in hidden as the same engine", () => {
  expect(sameEngineEntry(entry(), entry({ hidden: true }))).toBe(true);
  expect(sameEngineEntry(entry({ hidden: true }), entry())).toBe(true);
});

it.each([
  ["displayName", { displayName: "Other" }],
  ["config.cli", { config: { cli: "/bin/other" } }],
  ["enabled", { enabled: false }],
])("tells entries apart when %s differs", (_name, over) => {
  expect(sameEngineEntry(entry(), entry(over))).toBe(false);
});

it("is false when either side is missing", () => {
  expect(sameEngineEntry(undefined, entry())).toBe(false);
  expect(sameEngineEntry(entry(), undefined)).toBe(false);
  expect(sameEngineEntry(undefined, undefined)).toBe(false);
});

it("keeps the loaded engine only while the instance is still saved", () => {
  const saved = { claude: entry({ hidden: true }) };
  expect(keepsLoadedEngine("claude", saved, entry(), entry({ hidden: true }))).toBe(true);
  expect(keepsLoadedEngine("claude", saved, entry(), entry({ displayName: "Other" }))).toBe(false);
});

it("reloads a removed instance whose built-in entry reads back unchanged", () => {
  expect(keepsLoadedEngine("claudeApi", { claude: entry() }, entry(), entry())).toBe(false);
});
