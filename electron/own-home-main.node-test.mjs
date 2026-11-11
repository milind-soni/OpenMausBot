import assert from "node:assert/strict";
import test from "node:test";

import { handSaved, installOwnHome, openServerSession, OWNER_KNOWN_MS, OWNER_RETRY_MS, parseChoice } from "./own-home-main.mjs";

const ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const garage = { id: "g", kind: "remote", name: "Garage server", origin: "https://garage.example.test" };
const family = { id: "f", kind: "remote", name: "Family server", origin: "https://family.example.test" };

function memory(initial = null) {
  let value = initial;
  return { read: () => value, write: (next) => { value = next; } };
}

/** Servers as their own routes answer this window's sign-in: `own` by their own word, `move` when they take one. */
function servers(answers) {
  const asked = [];
  const fetch = async (url, init) => {
    const { origin, pathname } = new URL(url);
    asked.push({ origin, path: pathname, headers: init?.headers ?? {} });
    const server = answers[origin];
    if (server?.silent) return new Promise(() => {});
    if (server?.down) throw new TypeError("fetch failed");
    if (!server) return new Response("", { status: 502 });
    if (pathname === "/api/auth/session") return Response.json(server.signedIn === false ? { error: "unauthorized" } : { kind: "session", scopes: ["admin"], ...(server.own ? { own: true } : {}) }, { status: server.signedIn === false ? 401 : 200 });
    if (pathname === "/.well-known/openmausbot/environment") return Response.json({ environmentId: server.environmentId ?? ID, capabilities: server.move === false ? {} : { move: 1 } });
    return new Response("", { status: 404 });
  };
  return { fetch, asked };
}

function install({ answers, cloudJournal = null, journal = null, choice = null, now = () => 1_000 }) {
  const { fetch, asked } = servers(answers);
  const changes = [];
  const own = installOwnHome({
    localRequest: async () => new Response("", { status: 503 }),
    fetch,
    environments: () => [garage, family, { id: "home", kind: "remote", name: "My Cloud", origin: "https://omb-u-1.fly.dev", home: true }],
    handoff: async () => null,
    journal: memory(journal),
    choice: memory(choice),
    sendState: memory(),
    cloudJournal: () => cloudJournal,
    onChange: () => changes.push(1),
    now,
  });
  return { own, asked, changes };
}

test("a choice is kept only whole: the server's address, identity and name", () => {
  const good = { v: 1, id: "g", origin: garage.origin, environmentId: ID, name: "Garage server", at: 1 };
  assert.equal(parseChoice(good), good);
  for (const broken of [{ ...good, origin: "https://garage.example.test/pair" }, { ...good, environmentId: "not-an-id" }, { ...good, name: " " }, { ...good, v: 2 }, null]) {
    assert.equal(parseChoice(broken), null);
  }
});

test("only a server connected by hand can be made home: never This computer, My Cloud or a team's Cloud", () => {
  assert.equal(handSaved(garage), true);
  for (const place of [{ id: "local", kind: "local", name: "This computer" }, { ...garage, home: true }, { ...garage, cloud: { id: "c" } }, { ...garage, team: { id: "t" } }]) {
    assert.equal(handSaved(place), false);
  }
});

test("a server's circle offers Make my home only once it said it is this person's alone, while that word is fresh and nothing moves", async () => {
  let at = 1_000;
  const { own, changes } = install({ answers: { [garage.origin]: { own: true }, [family.origin]: { own: false } }, now: () => at });
  assert.equal(own.offers(garage), false, "not asked yet");
  own.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(own.offers(garage), true);
  assert.equal(own.offers(family), false, "others sign in there");
  assert.ok(changes.length > 0, "the rail hears that its word changed");
  at += OWNER_KNOWN_MS;
  assert.equal(own.offers(garage), false, "an old word is asked again first");
  own.close();

  const moving = install({ answers: { [garage.origin]: { own: true } }, cloudJournal: { v: 1, phase: "copy", cloud: { origin: "https://omb-u-1.fly.dev", account: "acct" } } });
  moving.own.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(moving.own.offers(garage), false, "this computer's bots are on their way to My Cloud");
  moving.own.close();
});

test("starting asks the server once more, and keeps this computer's bots here when it isn't theirs alone, isn't signed in or is too old", async () => {
  const cases = [
    [{ own: false }, "Garage server has other people on it, so your bots stay here."],
    [{ signedIn: false }, "This app isn't signed in to Garage server."],
    [{ own: true, move: false }, "Update OpenMausBot on Garage server first"],
  ];
  for (const [answer, words] of cases) {
    const { own } = install({ answers: { [garage.origin]: answer } });
    await assert.rejects(own.start("g"), (error) => error.message.includes(words));
    assert.equal(own.chosen(), null);
    own.close();
  }
  const cloud = install({ answers: { [garage.origin]: { own: true } }, cloudJournal: { v: 1, phase: "done", cloud: { origin: "https://omb-u-1.fly.dev", account: "acct" } } });
  await assert.rejects(cloud.own.start("g"), /moving to My Cloud/u);
  cloud.own.close();
  const unknown = install({ answers: {} });
  await assert.rejects(unknown.own.start("home"), /isn't in this app/u, "My Cloud is never made home this way");
  unknown.own.close();

  const { own, asked } = install({ answers: { [garage.origin]: { own: true } } });
  assert.deepEqual(await own.start("g"), { started: true });
  assert.deepEqual({ ...own.chosen(), at: 0 }, { v: 1, id: "g", origin: garage.origin, environmentId: ID, name: "Garage server", at: 0 });
  assert.ok(asked.every((ask) => ask.origin === garage.origin && ask.headers.origin === garage.origin), "only that server, same-origin, with the window's sign-in");
  assert.equal(own.active(), true, "no move to My Cloud starts now");
  await assert.rejects(own.start("g"), /already moving/u);
  own.close();
});

test("each pass goes over the window's sign-in only to the server chosen, while it is still that person's alone, and never signs it out", async () => {
  const chosen = { v: 1, id: "g", origin: garage.origin, environmentId: ID, name: "Garage server", at: 1 };
  const session = await openServerSession(chosen, servers({ [garage.origin]: { own: true } }).fetch);
  await session.close();
  await assert.rejects(openServerSession(chosen, servers({ [garage.origin]: { own: true, environmentId: "0d9e8f7a-6b5c-4d3e-9f8a-7b6c5d4e3f2a" } }).fetch), (error) => error.code === "other_server");
  await assert.rejects(openServerSession(chosen, servers({ [garage.origin]: { own: false } }).fetch), (error) => error.code === "not_own" && /other people on it now/u.test(error.message));
  await assert.rejects(openServerSession(chosen, servers({ [garage.origin]: { signedIn: false } }).fetch), (error) => error.code === "signed_out" && error.status === 401);
  const { fetch, asked } = servers({ [garage.origin]: { own: true } });
  await (await openServerSession(chosen, fetch)).close();
  assert.ok(!asked.some((ask) => ask.path === "/api/auth/logout"), "the window's own sign-in stays");
});

test("while the move goes, this computer's screen names the server; once home is there, This computer is no place of its own", () => {
  const choice = { v: 1, id: "g", origin: garage.origin, environmentId: ID, name: "Garage server", at: 1 };
  const cloud = { origin: garage.origin, account: `own:${ID}`, machine: garage.origin, name: "Garage server" };
  const moving = install({ answers: {}, choice, journal: { v: 1, phase: "final", cloud } });
  assert.deepEqual(moving.own.underWay(), { phase: "final", name: "Garage server" });
  assert.equal(moving.own.origin(), null);
  assert.equal(moving.own.home(), null, "nothing is lent before the switch");
  moving.own.close();
  const done = install({ answers: {}, choice, journal: { v: 1, phase: "done", cloud, doneAt: 1 } });
  assert.equal(done.own.underWay(), null);
  assert.equal(done.own.origin(), garage.origin);
  assert.deepEqual(done.own.home(), { id: "g", origin: garage.origin, environmentId: ID, name: "Garage server" });
  assert.equal(done.own.offers(garage), false);
  done.own.close();
});

test("a server that does not say who owns it is asked once at a time, and again only after OWNER_RETRY_MS", async () => {
  let at = 1_000;
  const { own, asked } = install({ answers: { [garage.origin]: { down: true }, [family.origin]: { silent: true } }, now: () => at });
  const to = (origin) => asked.filter((ask) => ask.origin === origin).length;
  own.refresh(); own.refresh(); own.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(to(garage.origin), 2, "its session and its environment, once");
  assert.equal(to(family.origin), 2, "a server still being asked is not asked again");
  own.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(to(garage.origin), 2, "a server that did not say is left alone for a while");
  assert.equal(own.offers(garage), false);
  at += OWNER_RETRY_MS;
  own.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(to(garage.origin), 4, "then asked again");
  assert.equal(to(family.origin), 2, "while its first ask still waits");
  own.close();
});
