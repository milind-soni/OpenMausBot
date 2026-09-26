import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyRoomPyramid } from "../scripts/verify-room-pyramid.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("discusses, revises, splits among members, delegates to separate groups and consolidates their outputs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "room-pyramid-evidence-"));
  try {
    const evidence = await verifyRoomPyramid(join(directory, "verification.json"));
    expect(evidence.bots).toHaveLength(15);
    expect(evidence.provider).toHaveLength(45);
  } finally { await removeTempDir(directory); }
}, 240_000);
