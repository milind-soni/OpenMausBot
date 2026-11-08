import { expect, it, vi } from "vitest";

it("fails closed until a turn guard is installed and when that guard throws", async () => {
  vi.resetModules();
  const guard = await import("./skill-use-guard.ts");
  expect(guard.skillMayBeInUse("bot")).toBe(true);
  guard.setSkillUseGuard(() => false);
  expect(guard.skillMayBeInUse("bot")).toBe(false);
  guard.setSkillUseGuard(() => { throw new Error("guard unavailable"); });
  expect(guard.skillMayBeInUse("bot")).toBe(true);
});
