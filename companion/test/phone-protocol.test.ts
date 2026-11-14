import { describe, expectTypeOf, it } from "vitest";

import type { CompanionEndpointsSnapshot, PairResponse, ServerFrame } from "../../packages/phone-protocol/src/wire.ts";
import type { PublicDevice } from "../src/devices.ts";
import type { E2EDescriptor } from "../src/e2e/descriptor.ts";
import type { CompanionEndpoint } from "../src/endpoints.ts";
import type { CompanionEndpointSnapshot } from "../src/proxy.ts";

describe("the phone protocol's types", () => {
  it("cover what the companion sends a phone", () => {
    type Endpoints = CompanionEndpointSnapshot & { version?: string; e2e?: E2EDescriptor };
    expectTypeOf<Endpoints>().toExtend<CompanionEndpointsSnapshot>();
    expectTypeOf<{ kind: "companion.endpoints" } & Endpoints>().toExtend<ServerFrame>();
    type Paired = { device: PublicDevice; token: string } & { serverName: string; hosts?: string[]; endpoints?: CompanionEndpoint[]; e2e?: E2EDescriptor };
    expectTypeOf<Paired>().toExtend<PairResponse>();
  });
});
