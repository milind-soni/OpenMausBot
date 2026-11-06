import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CLOUD_PLAN_TIER_FILE, createCloudPlanTier } from "./cloud-plan-tier.ts";

const dirs: string[] = [];
const dir = () => { const made = mkdtempSync(join(tmpdir(), "omb-plan-tier-")); dirs.push(made); return made; };
afterEach(() => { for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true }); });

describe("which plan this Cloud is on", () => {
  it("is not Starter until the Admin says so, and follows what it says at once, across a restart", () => {
    const dataDir = dir();
    let changes = 0;
    const plan = createCloudPlanTier({ dataDir, cloudHome: true, changed: () => { changes += 1; } });
    expect(plan.tier()).toBeUndefined();
    expect(plan.starter()).toBe(false);
    plan.set("starter");
    expect(plan.starter()).toBe(true);
    expect(createCloudPlanTier({ dataDir, cloudHome: true }).starter()).toBe(true);
    plan.set("starter");
    expect(changes).toBe(1);
    plan.set("pro");
    expect(plan.starter()).toBe(false);
    expect(changes).toBe(2);
    expect(JSON.parse(readFileSync(join(dataDir, CLOUD_PLAN_TIER_FILE), "utf8"))).toEqual({ v: 1, tier: "pro" });
  });

  it("treats Personal, a damaged file, a malformed tier and a server that is no Cloud as not Starter", () => {
    const dataDir = dir();
    const plan = createCloudPlanTier({ dataDir, cloudHome: true });
    plan.set("personal");
    expect(plan.starter()).toBe(false);
    plan.set("NOT A TIER");
    expect(plan.tier()).toBe("personal");
    writeFileSync(join(dataDir, CLOUD_PLAN_TIER_FILE), "{broken");
    expect(createCloudPlanTier({ dataDir, cloudHome: true }).starter()).toBe(false);
    const desktop = createCloudPlanTier({ dataDir: dir(), cloudHome: false });
    desktop.set("starter");
    expect(desktop.starter()).toBe(false);
    const leftover = dir();
    writeFileSync(join(leftover, CLOUD_PLAN_TIER_FILE), JSON.stringify({ v: 1, tier: "starter" }));
    expect(createCloudPlanTier({ dataDir: leftover, cloudHome: false }).starter()).toBe(false);
  });
});
