import { expect, it } from "vitest";

import en from "./en.json";

// The welcome is the first thing a new person reads, so it never uses the app's internal words.
// "computer" means only the person's own device there ("this computer", "your computer"); MCP servers keep their name.
const INTERNAL = /\b(?:engines?|instances?|workspaces?|Composio)\b|(?<!MCP )\bservers?\b|(?<!\b(?:this|your) )\bcomputers?\b/i;
// Pending, not yet guarded: "This computer" as a place name, "My Cloud", and "lent" / "lend" / "lending".

it("the welcome's English copy uses none of the app's internal words", () => {
  const offending = Object.entries(en)
    .filter(([key, value]) => /^(?:onboarding|cloudWelcome)\./.test(key) && INTERNAL.test(value))
    .map(([key]) => key);
  expect(offending).toEqual([]);
});

it("Settings describes the welcome as it now is: no phone step, no first-bot step", async () => {
  const { readFileSync } = await import("node:fs");
  const settings = readFileSync(new URL("../components/AppSettingsRows.tsx", import.meta.url), "utf8");
  const used = /subtitle=\{t\("(settings\.welcome\.[\w.]+)"\)\}/.exec(settings)?.[1] as keyof typeof en | undefined;
  expect(used).toBeDefined();
  expect(en[used!]).not.toMatch(/phone|first bot|providers/i);
});
