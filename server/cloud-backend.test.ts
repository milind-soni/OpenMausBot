import { describe, expect, it } from "vitest";

import {
  CLOUD_BACKEND_CHANGE_ERROR,
  VPS_ALIAS_CHANGE_ERROR,
  cloudBackendChangeError,
  vpsAliasChangeError,
} from "./cloud-backend.ts";

describe("cloud backend switching", () => {
  const activeTurnCases: Array<[string, boolean, boolean]> = [
    ["a busy bot", true, false],
    ["an active VPS thread", false, true],
  ];

  it.each(activeTurnCases)("rejects changes during %s", (_reason, busy, activeVpsThread) => {
    expect(cloudBackendChangeError(busy, activeVpsThread)).toBe(CLOUD_BACKEND_CHANGE_ERROR);
  });

  it("allows changes while idle", () => {
    expect(cloudBackendChangeError(false, false)).toBeNull();
  });

  it("keeps an active VPS turn on its original SSH host", () => {
    expect(vpsAliasChangeError("old-vps", "new-vps", true)).toBe(VPS_ALIAS_CHANGE_ERROR);
    expect(vpsAliasChangeError("old-vps", "old-vps", true)).toBeNull();
    expect(vpsAliasChangeError("old-vps", "new-vps", false)).toBeNull();
  });
});
