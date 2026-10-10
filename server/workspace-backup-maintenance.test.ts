import { expect, it } from "vitest";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

it("refuses in-flight requests and turns, gates new work, and unlocks on failure", async () => {
  const gate = new WorkspaceBackupMaintenance();
  let idle = true;
  let pauses = 0;
  let resumes = 0;
  const hooks = { idle: () => idle, pause: () => { pauses++; }, resume: () => { resumes++; }, flush: async () => {} };
  const release = gate.request();
  await expect(gate.run(async () => {}, hooks)).rejects.toMatchObject({ status: 409 });
  release();
  idle = false;
  await expect(gate.run(async () => {}, hooks)).rejects.toMatchObject({ status: 409 });
  idle = true;
  await expect(gate.run(async () => {
    expect(() => gate.request()).toThrow(/backup is in progress/);
    throw new Error("disk full");
  }, hooks)).rejects.toThrow("disk full");
  expect({ pauses, resumes, active: gate.active }).toEqual({ pauses: 1, resumes: 1, active: false });
  await gate.run(async () => "staged", hooks, true);
  expect(() => gate.assertAvailable()).toThrow(/restart/);
  expect(gate.pendingRestore).toBe(true);
  expect(resumes).toBe(1);
});
