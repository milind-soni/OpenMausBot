import { expect, it } from "vitest";
import { verifyRoomHandoffs } from "../scripts/verify-room-handoffs.ts";

it("routes a real three-layer MCP conversation and returns outcomes to both ancestors", async () => {
  const evidence = await verifyRoomHandoffs();
  expect(evidence.ok).toBe(true);
}, 120_000);
