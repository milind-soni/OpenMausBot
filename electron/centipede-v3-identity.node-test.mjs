import test from "node:test";
import assert from "node:assert/strict";

import { CENTIPEDE_V3_IDENTITY } from "./centipede-v3-identity.mjs";

test("Centipede V3 has a distinct desktop, runtime, protocol, and updater identity", () => {
  assert.deepEqual(CENTIPEDE_V3_IDENTITY, {
    appId: "com.openmausbot.centipede.v3",
    productName: "Centipede V3",
    executableName: "centipede-v3",
    protocol: "centipede-v3",
    serverPort: 18899,
    dataDirectory: "Centipede V3",
    updaterChannel: "centipede-v3",
  });
});
