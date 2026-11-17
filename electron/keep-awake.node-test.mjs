import assert from "node:assert/strict";
import test from "node:test";

import { reachableForKeepAwake } from "./keep-awake.mjs";

test("Keep this computer awake applies while the phone link runs or the person's other computers may open this one", () => {
  assert.equal(reachableForKeepAwake({ enabled: true }, { on: false }), true);
  assert.equal(reachableForKeepAwake({ enabled: false }, { on: true }), true, "the share alone: nothing paired, the phone link asleep");
  assert.equal(reachableForKeepAwake({ enabled: true, error: "port in use" }, { on: true }), true);
  assert.equal(reachableForKeepAwake({ enabled: true, error: "port in use" }, { on: false }), false);
  assert.equal(reachableForKeepAwake({ enabled: false }, { on: false }), false);
  assert.equal(reachableForKeepAwake({ enabled: false }, undefined), false);
});
