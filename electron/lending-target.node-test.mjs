import assert from "node:assert/strict";
import test from "node:test";

import { ownCloud } from "./cloud-list.mjs";
import { createLendingTarget } from "./lending-target.mjs";

test("lending's Cloud comes from the verified sign-in, and survives a brief disconnect of the same account only", () => {
  let state = { status: "connected", account: { id: "acct_1" }, machine: { origin: "https://omb-u-1.fly.dev" } };
  const cloud = { id: "cloud", origin: "https://omb-u-1.fly.dev" };
  const target = createLendingTarget({ account: () => ({ state: () => state }), environments: () => [{ id: "other", origin: "https://other.example" }, cloud] });
  assert.deepEqual(target.cloud(), { status: "connected", accountId: "acct_1", origin: "https://omb-u-1.fly.dev" });
  assert.equal(target.environment(), cloud);
  state = { status: "unavailable", account: { id: "acct_1" }, machine: null };
  assert.equal(target.environment(), cloud, "the same account, briefly unreachable");
  state = { status: "unavailable", account: { id: "acct_2" }, machine: null };
  assert.equal(target.environment(), null, "another account never inherits it");
  state = { status: "signed-out", message: "restoring", account: null, machine: null };
  assert.equal(target.cloud().status, "restoring");
  assert.equal(createLendingTarget({ account: () => null, environments: () => [cloud] }).environment(), null);
});

test("another Cloud of the person's own is checked at its own address while the session lists it; any other place against My Cloud", () => {
  const home = { id: "home", origin: "https://omb-u-1.fly.dev", home: true }, other = { id: "a", origin: "https://omb-c-a.fly.dev", cloud: { id: "c-a" } };
  const server = { id: "s", origin: "https://bots.example.test" }, gone = { id: "g", origin: "https://omb-c-gone.fly.dev", cloud: { id: "c-gone" } };
  const state = { status: "connected", account: { id: "acct-1" }, machine: { status: "ready", origin: home.origin } };
  const target = createLendingTarget({ account: () => ({ state: () => state, isOwnCloud: (origin) => [home.origin, other.origin].includes(origin) }), environments: () => [server, other, home, gone] });
  assert.deepEqual(target.cloud(other), { status: "connected", accountId: "acct-1", origin: other.origin });
  assert.equal(target.cloud(gone).origin, home.origin, "a Cloud the session no longer lists is checked against My Cloud, so lending to it ends");
  assert.equal(target.cloud(server).origin, home.origin);
  assert.equal(target.cloud().origin, home.origin);
});

test("this computer is lent to the person's own Clouds only, My Cloud first: never a Team Cloud, a server that only signed in, or a Cloud the session dropped", () => {
  const home = { id: "home", name: "My Cloud", origin: "https://omb-u-1.fly.dev", home: true };
  const other = { id: "a", name: "Client A", origin: "https://omb-c-a.fly.dev", cloud: { id: "c-a", role: "owner" } };
  const team = { id: "t", name: "Acme team", origin: "https://omb-t-acme.fly.dev", team: { id: "t-acme", role: "owner" } };
  const memberOf = { id: "m", name: "Their Cloud", origin: "https://omb-c-theirs.fly.dev", cloud: { id: "c-theirs", role: "member" } };
  const server = { id: "s", name: "Mac mini", origin: "https://mini.example.test", cloud: { id: "s-mini", role: "owner" } };
  const gone = { id: "g", name: "Old", origin: "https://omb-c-gone.fly.dev", cloud: { id: "c-gone", role: "owner" } };
  let state = { status: "connected", account: { id: "acct-1" }, machine: { status: "ready", origin: home.origin }, clouds: [
    { id: "c-home", origin: home.origin, teamId: null, role: "owner", primary: true },
    { id: "c-a", origin: other.origin, teamId: null, role: "owner" },
    { id: "c-team", origin: team.origin, teamId: "t-acme", role: "owner" },
    { id: "c-theirs", origin: memberOf.origin, teamId: null, role: "member" },
    { id: "s-mini", origin: server.origin, teamId: null, role: "owner", managed: false },
  ] };
  // As the verified session (cloud-account.mjs) answers it.
  const isOwnCloud = (origin) => state.status === "connected" && (state.machine?.origin === origin || state.clouds.some((cloud) => ownCloud(cloud) && cloud.origin === origin));
  const target = createLendingTarget({ account: () => ({ state: () => state, isOwnCloud }), environments: () => [team, server, memberOf, gone, other, home] });
  assert.deepEqual(target.places().map((place) => place.name), ["My Cloud", "Client A"]);
  state = { status: "signed-out", account: null, machine: null, clouds: [] };
  assert.deepEqual(target.places(), [], "signed out: no Cloud of anyone's");
});
