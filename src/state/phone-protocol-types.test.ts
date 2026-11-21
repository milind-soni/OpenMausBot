import { describe, expectTypeOf, it } from "vitest";

import type { WireInstance } from "../../packages/phone-protocol/src/responses.ts";
import type { InstanceInfo } from "./store";

describe("the phone protocol's model list", () => {
  it("is a subset of what the desktop reads from GET /api/instances", () => {
    expectTypeOf<InstanceInfo>().toExtend<WireInstance>();
  });
});
