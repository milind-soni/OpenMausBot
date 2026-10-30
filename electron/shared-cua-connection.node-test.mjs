import assert from "node:assert/strict";
import test from "node:test";
import { sharedCuaConnection } from "./shared-cua-connection.mjs";

test("a macOS or Windows connection is used as it is", () => {
  const connection = { mode: "embedded", mcpCommand: "/x/cua", mcpArgs: ["mcp"], mcpEnv: { A: "1" } };
  assert.equal(sharedCuaConnection(connection), connection);
});

test("a ready Linux connection yields its verified invocation and environment", () => {
  const linux = { status: "ready", mcp: { command: "/opt/cua-driver", args: ["mcp"] }, commandEnv: { DISPLAY: ":0" } };
  assert.deepEqual(sharedCuaConnection(linux), { mcpCommand: "/opt/cua-driver", mcpArgs: ["mcp"], mcpEnv: { DISPLAY: ":0" } });
});

test("an unavailable or half-formed connection yields nothing", () => {
  for (const connection of [null, { mode: "unavailable", reason: "x" }, { status: "unavailable", mcp: { command: "/c", args: ["mcp"] } }, { status: "ready", mcp: { command: "/c" } }, { mcpCommand: "/c" }])
    assert.equal(sharedCuaConnection(connection), null);
});
