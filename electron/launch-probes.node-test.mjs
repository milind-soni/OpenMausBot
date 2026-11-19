import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import { hostKind, programName, watchLaunchWork } from "./launch-probes.mjs";

test("a started program is kept under a fixed name: never its folder, its arguments or a name of its own", () => {
  assert.equal(programName("/usr/sbin/ioreg"), "ioreg");
  assert.equal(programName("C:\\Windows\\System32\\reg.exe"), "reg");
  assert.equal(programName("scutil --proxy", { shell: true }), "scutil");
  assert.equal(programName("scutil --proxy"), "other");
  assert.equal(programName("/Users/ada/Library/Application Support/OpenMausBot/bin/cua-driver"), "cua-driver");
  assert.equal(programName("/Users/ada/Library/Application Support/ioreg helper/tool", { shell: true }), "other");
  assert.equal(programName("/Users/ada/Projects/acme-merger/bin/lookup_customer"), "other");
  assert.equal(programName("/Users/ada/ioreg-secrets/tool"), "other");
  assert.equal(programName(undefined), "other");
  assert.equal(programName({ toString: () => "ioreg" }), "other");
});

test("a request is kept as the kind of its host; this computer is not a request at all", () => {
  assert.equal(hostKind("http://127.0.0.1:8799/api/health"), null);
  assert.equal(hostKind("http://localhost:5173/"), null);
  assert.equal(hostKind("https://accounts.openmausbot.com/token?code=abc"), "accounts");
  assert.equal(hostKind("https://omb-u-1.fly.dev/api/bots"), "cloud");
  assert.equal(hostKind(new URL("https://c-opaque.openmausbot.com/x")), "cloud");
  assert.equal(hostKind({ url: "https://github.com/milind-soni/OpenMausBot/releases" }), "updates");
  assert.equal(hostKind("https://raw.githubusercontent.com/x/y"), "updates");
  assert.equal(hostKind("https://intranet.acme.test/q?token=abc"), "other");
  assert.equal(hostKind("https://github.com.evil.test/"), "other");
  assert.equal(hostKind("not a url"), "other");
});

function fakeChildProcess() {
  const calls = [];
  const execFile = (command, ...rest) => { calls.push(["execFile", command]); const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); rest.at(-1)?.(null, "out"); return child; };
  execFile[promisify.custom] = (command) => { calls.push(["execFile.promise", command]); return Object.assign(Promise.resolve({ stdout: "out", stderr: "" }), { child: "the child" }); };
  return {
    calls,
    module: {
      execFile,
      spawn: (command) => { calls.push(["spawn", command]); return new EventEmitter(); },
      ["execFile" + "Sync"]: (command) => { calls.push(["blocking", command]); if (command === "fail") throw new Error("exit 1"); return "out"; },
      ChildProcess: class {}, notAStarter: () => "left alone",
    },
  };
}

test("programs are timed without changing what a caller gets back, and finish() puts everything back", async () => {
  const fake = fakeChildProcess();
  const originals = { ...fake.module };
  let clock = 0, synced = 0;
  const watch = watchLaunchWork({ childProcess: fake.module, sync: () => { synced += 1; }, now: () => clock });
  assert.equal(synced, 1);
  assert.notEqual(fake.module.execFile, originals.execFile);
  assert.equal(fake.module.notAStarter, originals.notAStarter);
  assert.equal(fake.module.ChildProcess, originals.ChildProcess);

  const blocking = fake.module["execFile" + "Sync"];
  assert.equal(blocking("/usr/sbin/ioreg"), "out");
  assert.throws(() => blocking("fail"), /exit 1/);
  const spawned = fake.module.spawn("/usr/sbin/scutil");
  clock = 40;
  spawned.emit("exit", 0);
  const promised = promisify(fake.module.execFile)("/Users/ada/bin/acme-tool");
  assert.equal(promised.child, "the child");
  assert.deepEqual(await promised, { stdout: "out", stderr: "" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(watch.counts().children, [{ name: "ioreg", ms: 0 }, { name: "other", ms: 0 }, { name: "scutil", ms: 40 }, { name: "other", ms: 0 }]);
  const counted = watch.finish();
  assert.equal(synced, 2);
  assert.deepEqual({ ...fake.module }, originals);
  fake.module.spawn("ioreg").emit("exit", 0);
  assert.deepEqual(watch.finish(), counted);
  assert.deepEqual(fake.calls.map(([kind]) => kind), ["blocking", "blocking", "spawn", "execFile.promise", "spawn"]);
});

test("requests off this computer are counted by kind while the same promise is handed back; failures count too", async () => {
  let clock = 0;
  const answers = [];
  const owner = { fetch(url) { const answer = url.includes("down") ? Promise.reject(new Error("offline")) : Promise.resolve({ ok: true }); answers.push(answer); return answer; } };
  const original = owner.fetch;
  const frozen = Object.freeze({ fetch: () => Promise.resolve() });
  const watch = watchLaunchWork({ fetchOwners: [owner, frozen, {}, null], now: () => clock });
  const first = owner.fetch("https://accounts.openmausbot.com/token?code=abc");
  assert.equal(first, answers[0]);
  clock = 120;
  await first;
  await assert.rejects(owner.fetch("https://down.example.test/x"), /offline/);
  await owner.fetch("http://127.0.0.1:8799/api/health");
  await owner.fetch("https://omb-u-1.fly.dev/a");
  await owner.fetch("https://omb-u-1.fly.dev/b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(watch.finish().net, { accounts: { n: 1, ms: 120 }, other: { n: 1, ms: 0 }, cloud: { n: 2, ms: 0 } });
  assert.equal(owner.fetch, original);
});

test("a watch with nothing to watch counts what it is told and never throws", () => {
  const watch = watchLaunchWork();
  watch.child("/usr/sbin/sysctl", 3.4);
  watch.request("updates", 20.6);
  watch.request(null, 5);
  assert.deepEqual(watch.finish(), { children: [{ name: "sysctl", ms: 3 }], net: { updates: { n: 1, ms: 21 } } });
  watch.child("ioreg", 1);
  assert.equal(watch.finish().children.length, 1);
});
