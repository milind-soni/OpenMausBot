import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/** companionRevoke alone, with the sidecar, its store and the transition queue stubbed. */
function revokeWith({ running, removeAtRest = () => true, control = async () => ({}), portServed = false }) {
  // A Windows checkout has CRLF line ends: the function is cut out by its "\n}\n" end.
  const source = readFileSync(new URL("./companion.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("export async function companionRevoke");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = vm.createContext({
    proc: running ? {} : null,
    CONTROL_PORT: 8811,
    controlPortServed: async () => { calls.push(["port probe"]); return portServed; },
    serialize: (work) => { calls.push(["serialize"]); return Promise.resolve().then(work); },
    removePairedDeviceAtRest: (id) => { calls.push(["at rest", id]); return removeAtRest(id); },
    control: async (...args) => { calls.push(args); return control(...args); },
    companionState: async () => ({ enabled: running }),
    e2eHooks: { changed: () => {} },
  });
  vm.runInContext(source.slice(start, end + 2).replace("export ", ""), context);
  return { revoke: context.companionRevoke, calls };
}

test("Remove with the phone link asleep takes the phone out of the store it loads at start", async () => {
  const { revoke, calls } = revokeWith({ running: false });
  await revoke("phone-1");
  assert.deepEqual(calls, [["serialize"], ["port probe"], ["at rest", "phone-1"]]);
});

test("asleep, a companion this app did not start keeps the phone: the removal is refused, the store untouched", async () => {
  const { revoke, calls } = revokeWith({ running: false, portServed: true });
  await assert.rejects(revoke("phone-1"), /already serving another companion/);
  assert.deepEqual(calls, [["serialize"], ["port probe"]]);
});

test("a removal that could not be saved while asleep is an error, never a quiet success", async () => {
  const { revoke } = revokeWith({ running: false, removeAtRest: () => { throw new Error("could not save"); } });
  await assert.rejects(revoke("phone-1"), /could not save/);
});

test("Remove with the phone link running goes to the sidecar, and its failure reaches the page", async () => {
  const { revoke, calls } = revokeWith({ running: true });
  await revoke("phone-1");
  assert.deepEqual(calls, [["DELETE", "/devices/phone-1"]]);
  const failing = revokeWith({ running: true, control: async () => { throw new Error("companion control 500"); } });
  await assert.rejects(failing.revoke("phone-1"), /companion control 500/);
});

test("an id that could shape a path is refused in both states", async () => {
  for (const running of [false, true]) {
    const { revoke, calls } = revokeWith({ running });
    for (const id of ["../other", "phone?all=1", "a".repeat(65), "", undefined]) await revoke(id);
    assert.deepEqual(calls, []);
  }
});
