import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyRoomDiscussion } from "../scripts/verify-room-discussion.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("discusses with existing members in every layer, revises decisions and only then delegates", async () => {
  const folder = mkdtempSync(join(tmpdir(), "room-discussion-evidence-"));
  try {
    const evidence = await verifyRoomDiscussion(join(folder, "verification.json"));
    expect(evidence.nodes.filter((node: any) => node.kind === "discussion")).toHaveLength(3);
    expect(evidence.provider).toHaveLength(14);
    expect(evidence.checks).toContain("premature forwarding rejected before and during discussion");
  } finally { await removeTempDir(folder); }
}, 150_000);
