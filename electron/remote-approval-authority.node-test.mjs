import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDesktopKey, createRemoteApprovalAuthority, signedRequest, fingerprint } from "./remote-approval-authority.mjs";
import { createRemoteApprovalClient } from "./remote-approval-client.mjs";
import { FULL_ACCESS_WARNING } from "../shared/full-access-warning.mjs";

const context = { workspace: "host", device: "paired-owner", origin: "https://mini.example", epoch: "boot", requestId: "private-request" };
function fixture() {
  let document = {};
  let live = true;
  let clock = Date.now();
  const calls = [];
  const key = createDesktopKey();
  const authority = createRemoteApprovalAuthority({
    read: () => document, update: async derive => { document = derive(document); },
    validate: async () => { if (!live) throw new Error("revoked"); },
    now: () => clock,
    execute: async (ctx, claim, mode) => { calls.push({ ctx, claim, mode }); return { id: claim.botId, approvalMode: "ask", tasks: [{ threadId: claim.threadId, approvalMode: mode }] }; },
  });
  const scope = { ...context, botId: "bot", threadId: "thread", mode: "full", grantId: randomUUID() };
  const packet = action => signedRequest(key, { ...scope, action }, clock);
  const enroll = async () => {
    await authority.handle(packet("enroll"), context);
    await authority.authorize(authority.pending()[0].id);
  };
  return { authority, key, calls, scope, packet, enroll, revokePairing: () => { live = false; }, advance: ms => { clock += ms; } };
}

test("legacy pairing cannot authorize; only private owner enrollment enables the scoped key", async () => {
  const f = fixture();
  await assert.rejects(f.authority.handle(f.packet("full"), context), /Authorize/);
  await f.enroll();
  const result = await f.authority.handle(f.packet("full"), context);
  assert.equal(result.bot.approvalMode, "ask");
  assert.equal(f.calls[0].claim.threadId, "thread");
  assert.equal(f.authority.bindings()[0].fingerprint, fingerprint(f.key.publicKey));
  await f.authority.stop();
  assert.equal(f.calls.at(-1).mode, "ask");
});

test("proofs reject replay, tampering, origin/workspace/device/epoch mismatch and expiry", async () => {
  const f = fixture();
  await f.enroll();
  const packet = f.packet("status");
  await f.authority.handle(packet, context);
  await assert.rejects(f.authority.handle(packet, context), /replay/);
  for (const field of ["workspace", "device", "origin", "epoch"]) {
    await assert.rejects(f.authority.handle(f.packet("status"), { ...context, [field]: "wrong" }), /proof/);
  }
  const altered = f.packet("full");
  altered.claim.threadId = "sibling";
  await assert.rejects(f.authority.handle(altered, context), /signature/);
  const expired = f.packet("status");
  f.advance(30_001);
  await assert.rejects(f.authority.handle(expired, context), /proof/);
  assert.equal(f.calls.length, 0);
});

test("host rechecks pairing before enrollment; pending enrollment expires", async () => {
  const f = fixture();
  await f.authority.handle(f.packet("enroll"), context);
  const id = f.authority.pending()[0].id;
  f.revokePairing();
  await assert.rejects(f.authority.authorize(id), /revoked/);
  f.advance(120_001);
  await assert.rejects(f.authority.authorize(id), /expired/);
});

test("revocation recovers only the granted thread and refuses future proofs", async () => {
  const f = fixture();
  await f.enroll();
  await f.authority.handle(f.packet("full"), context);
  await f.authority.revoke(f.authority.bindings()[0].id);
  assert.deepEqual(f.calls.map(call => [call.claim.botId, call.claim.threadId, call.mode]), [["bot", "thread", "full"], ["bot", "thread", "ask"]]);
  await assert.rejects(f.authority.handle(f.packet("renew"), context), /Authorize/);
});

test("renew and cancellation cannot target another conversation", async () => {
  const f = fixture();
  await f.enroll();
  await f.authority.handle(f.packet("full"), context);
  for (const action of ["renew", "cancel"]) {
    await assert.rejects(f.authority.handle(signedRequest(f.key, { ...f.scope, threadId: "sibling", action }), context), /target|ended/);
  }
  await f.authority.stop();
});

test("native saved-environment client enrolls, uses the same warning and compensates lost replies", async () => {
  let doc = {};
  const f = fixture();
  const actions = [];
  const dialogs = [];
  let loseReply = false;
  const client = createRemoteApprovalClient({
    read: () => doc, update: async derive => { doc = derive(doc); },
    current: () => ({ origin: context.origin, name: "Mac Mini — Tailscale" }),
    dialog: async options => { dialogs.push(options); return { response: 1 }; },
    fetch: async (_url, init) => {
      if (init.method === "GET") return { ok: true, json: async () => context };
      assert.equal(init.redirect, "error");
      const packet = JSON.parse(init.body);
      actions.push(packet.claim.action);
      const answer = await f.authority.handle(packet, context);
      if (packet.claim.action === "full" && loseReply) throw new Error("lost reply");
      return { ok: true, json: async () => answer };
    },
  });
  assert.equal((await client.status()).available, false);
  await client.enroll();
  await f.authority.authorize(f.authority.pending()[0].id);
  assert.equal((await client.status()).available, true);
  loseReply = true;
  await assert.rejects(client.setFull("bot", "thread"), /lost reply/);
  assert.equal(actions.at(-1), "cancel");
  assert.ok(dialogs.at(-1).detail.includes(FULL_ACCESS_WARNING));
  assert.equal(dialogs.at(-1).defaultId, 0);
  assert.equal(f.calls.at(-1).mode, "ask");
  await client.stop();
});
