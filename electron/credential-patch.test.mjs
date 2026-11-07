import { describe, expect, it } from "vitest";

import { PROVIDER_CREDENTIAL_TARGETS, credentialConfigPatch } from "../shared/credential-request.ts";
import { PROVIDER_KEY_PATCH } from "./credential-patch.mjs";

describe("PROVIDER_KEY_PATCH", () => {
  it("saves each provider key where Settings → Keys saves it", () => {
    expect(Object.keys(PROVIDER_KEY_PATCH).sort()).toEqual([...PROVIDER_CREDENTIAL_TARGETS].sort());
    for (const target of PROVIDER_CREDENTIAL_TARGETS) expect(PROVIDER_KEY_PATCH[target]("v")).toEqual(credentialConfigPatch(target, "v"));
  });
});
