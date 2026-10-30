import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { createComputerSharing } from "./computer-sharing.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "omb-sharing-races-"));
  const file = path.join(dir, "computer-sharing.json");
  const env = { id: "cloud", origin: "https://cloud.fixture.test", name: "Cloud" };
  const info = { sessionId: randomUUID(), environmentId: randomUUID() };
  const connects = [];
  const polled = Promise.withResolvers();
  let heldIdentity = null;
  const sharing = createComputerSharing({
    file, environments: () => [env], enabled: async () => true, home: dir,
    cloud: () => ({ status: "connected", accountId: "account-1", origin: env.origin }),
    async fetch(url, { signal, body }) {
      const route = new URL(url).pathname;
      if (route === "/api/auth/session") {
        const held = heldIdentity;
        heldIdentity = null;
        if (held) { held.entered.resolve(); await held.released.promise; }
        return Response.json({ kind: "session", id: info.sessionId, cloudHome: true, scopes: ["admin"] });
      }
      if (route === "/.well-known/openmausbot/environment") return Response.json({ environmentId: info.environmentId, capabilities: { sharedComputers: true } });
      if (route === "/api/shared-computers/connect") connects.push(JSON.parse(body));
      if (route.endsWith("/poll")) await new Promise((resolve, reject) => {
        polled.resolve();
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return Response.json({ ok: true });
    },
  });
  t.after(async () => { sharing.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    sharing, env, info, connects, dir, polled: polled.promise,
    records: async () => JSON.parse(await readFile(file, "utf8")).records,
    holdIdentity() {
      const held = { entered: Promise.withResolvers(), released: Promise.withResolvers() };
      heldIdentity = held;
      t.after(() => held.released.resolve());
      return { entered: held.entered.promise, release: held.released.resolve };
    },
  };
}

for (const mode of ["Cloud", "Computer access"]) {
  const save = (f, terminal) => mode === "Cloud"
    ? f.sharing.saveCloud(f.env, { folders: [], internet: true, terminal })
    : f.sharing.save(f.env, { folders: [], computer: true, terminal }, f.info);

  test(`${mode}: Stop invalidates a pending terminal grant`, async t => {
    const f = await fixture(t);
    await save(f, false);
    await f.polled;
    const held = f.holdIdentity();
    const saving = save(f, true);
    await held.entered;
    f.sharing.revoke(f.env);
    held.release();
    const result = await saving;
    assert.equal(result.enabled, false);
    const kept = (await f.records())[f.env.id];
    assert.equal(kept.enabled, false);
    assert.equal(kept.terminal, false);
    assert.equal(kept.stopped.reason, "you");
    assert.equal(f.sharing.lendingToCloud(), false);
    assert.ok(f.connects.every(grant => grant.terminal === false));
  });

  test(`${mode}: forgetting an environment invalidates its pending grant`, async t => {
    const f = await fixture(t);
    const held = f.holdIdentity();
    const saving = save(f, true);
    await held.entered;
    f.sharing.forget(f.env);
    held.release();
    assert.equal((await saving).enabled, false);
    assert.deepEqual(await f.records(), {});
    assert.equal(f.sharing.lendingToCloud(), false);
    assert.deepEqual(f.connects, []);
  });

  test(`${mode}: a newer save keeps its capabilities when an older save finishes`, async t => {
    const f = await fixture(t);
    const held = f.holdIdentity();
    const older = save(f, true);
    await held.entered;
    await save(f, false);
    const kept = (await f.records())[f.env.id];
    held.release();
    assert.equal((await older).terminal, false);
    assert.deepEqual((await f.records())[f.env.id], kept);
    assert.equal(kept.enabled, true);
    assert.ok(f.connects.every(grant => grant.terminal === false));
  });
}

test("declining access invalidates a pending grant", async t => {
  const f = await fixture(t);
  const held = f.holdIdentity();
  const saving = f.sharing.save(f.env, { folders: [], terminal: true }, f.info);
  await held.entered;
  f.sharing.decline(f.env, f.info);
  held.release();
  assert.equal((await saving).enabled, false);
  assert.equal((await f.records())[f.env.id].terminal, false);
  assert.deepEqual(f.connects, []);
});

test("a change to another environment leaves a pending grant valid", async t => {
  const f = await fixture(t);
  const held = f.holdIdentity();
  const saving = f.sharing.saveCloud(f.env, { folders: [], terminal: true });
  await held.entered;
  f.sharing.revoke({ ...f.env, id: "other" });
  held.release();
  assert.equal((await saving).enabled, true);
  assert.equal((await f.records())[f.env.id].terminal, true);
});

test("a stopped worker cannot restore its terminal grant after identity refresh", async t => {
  const f = await fixture(t);
  await f.sharing.saveCloud(f.env, { folders: [], terminal: true });
  await f.polled;
  const held = f.holdIdentity();
  f.sharing.start();
  await held.entered;
  f.sharing.revoke(f.env);
  const stopped = (await f.records())[f.env.id];
  f.info.sessionId = randomUUID();
  held.release();
  await setImmediate();
  assert.deepEqual((await f.records())[f.env.id], stopped);
  f.sharing.cloudChanged();
  f.sharing.start();
  await setImmediate();
  assert.equal(f.sharing.cloudState(f.env).enabled, false);
  assert.equal(f.sharing.cloudState(f.env).terminal, false);
  assert.equal(f.sharing.lendingToCloud(), false);
  assert.deepEqual((await f.records())[f.env.id], stopped);
  assert.equal(f.connects.length, 1);
});
