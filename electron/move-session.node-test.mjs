import assert from "node:assert/strict";
import test from "node:test";

import { createMoveSession } from "./move-session.mjs";

const A = { origin: "https://omb-t-1.fly.dev" }, B = { origin: "https://omb-t-2.fly.dev" };

/** My Cloud's owner sessions as the move opens them: `refuse` answers 401 to a session's requests (My Cloud forgot it). */
function cloud({ failOpen = 0, refuse = () => false } = {}) {
  const w = { opened: [], closed: [], asked: [] };
  w.open = async (target) => {
    if (failOpen > 0) { failOpen--; throw Object.assign(new Error("Cloud request failed."), { status: 429 }); }
    const id = `${target.origin}#${w.opened.length + 1}`;
    w.opened.push(id);
    const answer = (route) => { w.asked.push(`${id} ${route}`); return refuse(id, route) ? { ok: false, status: 401, body: null } : { ok: true, status: 200, body: { id } }; };
    return {
      call: async (_method, route) => answer(route),
      upload: async (route) => answer(route),
      fetch: async (route) => { const got = answer(route); return new Response(JSON.stringify(got.body), { status: got.status }); },
      close: async () => { w.closed.push(id); },
    };
  };
  return w;
}

test("every pass of a move uses one session, kept when a pass closes it, and signed out once at the end", async () => {
  const w = cloud();
  const moves = createMoveSession({ open: w.open });
  for (const route of ["/api/cloud-send", "/api/cloud-send/manifest", "/api/cloud-send/arrived"]) {
    const session = await moves.open(A);
    assert.equal((await session.call("GET", route)).body.id, `${A.origin}#1`);
    await session.close();
  }
  await (await moves.open(A)).upload("/api/attachments", new Uint8Array([1]), "image/png");
  assert.equal((await (await moves.open(A)).fetch("/api/cloud-send/files")).status, 200);
  assert.deepEqual([w.opened, w.closed], [[`${A.origin}#1`], []]);
  await moves.end();
  await moves.end();
  assert.deepEqual(w.closed, [`${A.origin}#1`]);
  assert.equal(moves.held(), false);
  await moves.open(A);
  assert.deepEqual(w.opened, [`${A.origin}#1`, `${A.origin}#2`], "a move that goes on after it ended opens a new one");
});

test("a session My Cloud no longer knows is replaced once and the request goes again; a replacement refused too is not replaced again", async () => {
  const forgot = new Set([`${A.origin}#1`]);
  const w = cloud({ refuse: (id) => forgot.has(id) });
  const moves = createMoveSession({ open: w.open });
  const session = await moves.open(A);
  assert.deepEqual(await session.call("GET", "/api/cloud-send"), { ok: true, status: 200, body: { id: `${A.origin}#2` } });
  assert.equal((await session.upload("/api/attachments")).body.id, `${A.origin}#2`, "the pass's other requests use the new one");
  assert.deepEqual(w.opened, [`${A.origin}#1`, `${A.origin}#2`]);

  forgot.add(`${A.origin}#2`);
  assert.equal((await session.call("GET", "/api/cloud-send")).status, 401, "the replacement refused too is not replaced again");
  assert.equal((await session.fetch("/api/cloud-send/files")).status, 401);
  assert.equal(w.opened.length, 2, "so a route that always refuses costs one code at most");
});

test("a session that could not be opened is not kept, and one for another Cloud signs the first one out", async () => {
  const w = cloud({ failOpen: 1 });
  const moves = createMoveSession({ open: w.open });
  await assert.rejects(moves.open(A), (error) => error.status === 429);
  assert.equal(moves.held(), false);
  await moves.open(A);
  await moves.open(B);
  assert.deepEqual([w.opened, w.closed], [[`${A.origin}#1`, `${B.origin}#2`], [`${A.origin}#1`]]);
});
