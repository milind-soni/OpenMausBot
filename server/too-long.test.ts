import { describe, expect, it } from "vitest";
import { z } from "zod";

import { coordinateTooLong, tooLongRefusal } from "./too-long.ts";

const shape = z.object({
  botIds: z.array(z.string()).min(1).max(4),
  message: z.string().trim().min(1).max(4000),
  reason: z.string().trim().max(200).optional(),
  title: z.string().trim().max(80).optional(),
  done_when: z.string().trim().max(1000).optional(),
});
const refusal = (body: unknown) => {
  const parsed = shape.safeParse(body);
  if (parsed.success) throw new Error("expected a refusal");
  return coordinateTooLong(parsed.error.issues);
};

describe("calls refused for length", () => {
  it("names the field and limit, says nothing happened, and says how to send it again", () => {
    expect(tooLongRefusal("detail", 600, "Keep the fact, then send it again."))
      .toBe("detail is over its 600-character limit, so nothing was done. Keep the fact, then send it again.");
  });

  it("tells a coordinate_bots caller how to shorten each long field", () => {
    expect(refusal({ botIds: ["a"], message: "x".repeat(4001) })).toContain("message is over its 4000-character limit");
    expect(refusal({ botIds: ["a"], message: "x".repeat(4001) })).toContain("save the long detail to a file");
    expect(refusal({ botIds: ["a"], message: "ok", done_when: "x".repeat(1001) })).toContain("done_when is over its 1000-character limit");
    expect(refusal({ botIds: ["a"], message: "ok", title: "x".repeat(81) })).toContain("title is over its 80-character limit");
  });

  it("leaves any other refusal to the general words", () => {
    expect(refusal({ botIds: ["a", "b", "c", "d", "e"], message: "ok" }), "too many teammates is no length").toBeUndefined();
    expect(refusal({ botIds: [], message: "" })).toBeUndefined();
    expect(refusal({ botIds: ["a", "b", "c", "d", "e"], message: "x".repeat(4001) }), "the general words cover both").toBeUndefined();
  });
});
