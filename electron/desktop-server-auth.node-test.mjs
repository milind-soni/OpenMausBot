import assert from "node:assert/strict";
import { test } from "node:test";

import authModule from "./desktop-server-auth.cjs";

const { DESKTOP_MUTATION_HEADER, desktopServerHeaders } = authModule;
const TOKEN = "a".repeat(43);

test("adds the owner capability to packaged main-process mutations", () => {
  assert.deepEqual(desktopServerHeaders(
    { "content-type": "application/json" },
    { packaged: true, token: TOKEN },
  ), {
    "content-type": "application/json",
    [DESKTOP_MUTATION_HEADER]: TOKEN,
  });
});

test("leaves development requests unchanged and rejects bad packaged tokens", () => {
  assert.deepEqual(desktopServerHeaders({ accept: "application/json" }, {
    packaged: false,
    token: "",
  }), { accept: "application/json" });
  assert.throws(() => desktopServerHeaders({}, { packaged: true, token: "short" }), /invalid/);
});
