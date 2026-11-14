import assert from "node:assert/strict";
import test from "node:test";

import { createLocalComputerGrant, LOCAL_COMPUTER_GRANT, localComputerGrantMessage } from "./local-computer-grant.mjs";

const child = () => {
  const sent = [];
  return { sent, postMessage: (message) => sent.push(message) };
};
const READY = { mode: "embedded", status: "ready", socketPath: "/x.sock", mcpCommand: "/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };

test("hands the app's own server child the driver connection, and every change after", () => {
  let record = READY;
  const grant = createLocalComputerGrant({ connection: () => record });
  const server = child();
  grant.attach(server, () => true);
  assert.deepEqual(server.sent, [{ type: LOCAL_COMPUTER_GRANT, connection: READY }]);
  record = { mode: "unavailable", reason: "desktop-host-stopped" };
  grant.changed();
  assert.deepEqual(server.sent.at(-1), { type: LOCAL_COMPUTER_GRANT, connection: record });
});

test("sends nothing to a child that is no longer the app's current server, and moves to the new one", () => {
  const grant = createLocalComputerGrant({ connection: () => READY });
  const old = child();
  const current = new Set([old]);
  grant.attach(old, (proc) => current.has(proc));
  const next = child();
  current.clear();
  current.add(next);
  grant.changed();
  assert.equal(old.sent.length, 1);
  grant.attach(next, (proc) => current.has(proc));
  assert.deepEqual(next.sent, [{ type: LOCAL_COMPUTER_GRANT, connection: READY }]);
});

test("a missing or odd record is sent as no connection, and a failed send is only logged", () => {
  assert.deepEqual(localComputerGrantMessage(undefined), { type: LOCAL_COMPUTER_GRANT, connection: null });
  assert.deepEqual(localComputerGrantMessage([READY]), { type: LOCAL_COMPUTER_GRANT, connection: null });
  const lines = [];
  const grant = createLocalComputerGrant({ connection: () => null, log: (line) => lines.push(line) });
  grant.attach({ postMessage: () => { throw new Error("channel closed"); } }, () => true);
  assert.match(lines[0], /channel closed/);
  grant.changed();
  assert.equal(lines.length, 2);
});
