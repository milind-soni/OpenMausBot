import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dropRetiredApps, removeRetiredAppFiles } from "./retired-apps.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

describe("retired connected apps", () => {
  it("leave a bot's scopes and grants, which keep every other app as it was", () => {
    const bot = { connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] }, highlevel: { tools: "*" as const } }, connectorScopes: { apps: { gmail: "read" as const, highlevel: "write" as const } } };
    expect(dropRetiredApps(bot)).toBe(true);
    expect(bot).toEqual({ connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } }, connectorScopes: { apps: { gmail: "read" } } });
    expect(dropRetiredApps(bot), "nothing left to drop").toBe(false);
    const unscoped = {};
    expect(dropRetiredApps(unscoped)).toBe(false);
    expect(unscoped).toEqual({});
  });

  it("leave the data folder with their sealed tokens and key, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-retired-apps-")); dirs.push(dir);
    const retired = ["highlevel.json.enc", "highlevel-key", "highlevel.json.enc.4242.05a7b3e0-1234-4abc-8def-0123456789ab.tmp"];
    const kept = ["logins.json.enc", "logins-key", "highlevel.md"];
    for (const name of [...retired, ...kept]) writeFileSync(join(dir, name), "x");
    expect(removeRetiredAppFiles(dir).sort()).toEqual([...retired].sort());
    for (const name of retired) expect(existsSync(join(dir, name)), name).toBe(false);
    for (const name of kept) expect(existsSync(join(dir, name)), name).toBe(true);
    expect(removeRetiredAppFiles(join(dir, "missing"))).toEqual([]);
  });
});
