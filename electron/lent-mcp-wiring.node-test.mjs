import assert from "node:assert/strict";
import test from "node:test";

import { lentMcpOptions } from "./lent-mcp-wiring.mjs";

test("lentMcpOptions builds the door with the computer's own ports and passes door options through", async () => {
  const asked = [];
  let approvals = {};
  const sharing = () => ({ mcpApprovals: { read: () => approvals, write: next => { approvals = next; } } });
  const { mcp } = lentMcpOptions({ sharing, prompt: async ask => { asked.push(ask); return false; }, serverPorts: () => [48123], declineMs: 0, now: () => 5 });
  const door = mcp({ id: "env" }, async () => ({ command: "node", args: ["server.js"], env: {} }));
  assert.equal(typeof door.open, "function");
  // 48123 is the app's own server: never reachable through a lent door.
  assert.deepEqual(await door.open({ name: "mine", port: 48123 }), { failed: "bad-port" });
  assert.deepEqual(asked, []);
  door.close();
});
