import { describe, expect, it } from "vitest";

import { internalBodyRefusal } from "./internal-body-ids.ts";

describe("an internal request body's bot and conversation", () => {
  it("passes a body that names none, or only the bearer's own", () => {
    expect(internalBodyRefusal({ event: "PostToolUse", payload: { botId: "other" } }, "b1", "t1")).toBeNull();
    expect(internalBodyRefusal({ fromBotId: "b1", botId: "b1", fromThreadId: "t1", threadId: "t1" }, "b1", "t1")).toBeNull();
    for (const body of [null, undefined, "text", 42, ["b2"]]) expect(internalBodyRefusal(body, "b1", "t1")).toBeNull();
  });

  it("refuses a body that names another bot", () => {
    for (const key of ["fromBotId", "botId"]) {
      expect(internalBodyRefusal({ [key]: "b2" }, "b1", "t1")).toEqual({ status: 403, error: "the internal capability belongs to a different bot" });
    }
  });

  it("refuses a body that names another conversation", () => {
    for (const key of ["fromThreadId", "threadId"]) {
      expect(internalBodyRefusal({ [key]: "t2" }, "b1", "t1")).toEqual({ status: 403, error: "the internal capability belongs to a different conversation" });
    }
  });
});
