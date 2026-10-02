import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localVmStopReason, recordLocalVmIdleStop } from "./local-vm-stop-reason.ts";

it("remembers an idle stop across reads without mislabelling another target or a later external stop", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-stop-reason-"));
  try {
    const status = { container: "stopped", stopped_at: "2026-10-01T12:00:00Z" };
    recordLocalVmIdleStop("shared", status.stopped_at, dir);
    expect(localVmStopReason("shared", status, dir)).toBe("idle");
    expect(localVmStopReason("bot:other", status, dir)).toBeNull();
    expect(localVmStopReason("shared", { ...status, stopped_at: "2026-10-01T13:00:00Z" }, dir)).toBeNull();
    expect(localVmStopReason("shared", { ...status, container: "running" }, dir)).toBeNull();
    expect(localVmStopReason("shared", { container: "stopped" }, dir)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
