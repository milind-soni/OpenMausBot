import assert from "node:assert/strict";
import test from "node:test";

import { appLink, appLinkFromCommandLine, launcherLink, parseAppLink, validAppId } from "./app-link.mjs";
import { createAppLaunches } from "./app-launches.mjs";
import { chatLinkFrom, chatLinkFromCommandLine } from "./chat-link.mjs";

const ID = "la_AbCdEfGhIjKlMnOp";

test("one parser for a saved app's link: the store's id shape, an optional slash, `?window=1` the only query", () => {
  assert.deepEqual(parseAppLink(appLink(ID)), { id: ID, window: false });
  assert.deepEqual(parseAppLink(launcherLink(ID)), { id: ID, window: true });
  assert.deepEqual(parseAppLink(` OpenMausBot://APP/${ID}/ `), { id: ID, window: false });
  assert.deepEqual(parseAppLink(`openmausbot://app/${ID}/?window=1`), { id: ID, window: true });
  for (const link of ["openmausbot://app/notes", "openmausbot://app/la_short", `openmausbot://app/${ID}x`, `openmausbot://app/${ID}?window=0`,
    `openmausbot://app/${ID}?window=1&x=2`, `openmausbot://app/${ID}#window=1`, `openmausbot://app/../${ID}`, `openmausbot://thread/${ID}`,
    `https://example.com/app/${ID}`, `openmausbot://app/${ID}`.padEnd(300, "/"), 7, null]) assert.equal(parseAppLink(link), null, String(link));
  assert.throws(() => appLink("../x"));
  assert.equal(validAppId(ID), true);
  assert.deepEqual(appLinkFromCommandLine(["/Applications/OpenMausBot.app", "--flag", launcherLink(ID)]), { id: ID, window: true });
  assert.equal(appLinkFromCommandLine(["exe"]), null);
});

test("an in-app app link is the page's; a launcher's is not a chat link at all", () => {
  assert.equal(chatLinkFrom(appLink(ID)), appLink(ID));
  assert.equal(chatLinkFrom(launcherLink(ID)), null);
  assert.equal(chatLinkFrom("openmausbot://app/notes"), null);
  assert.equal(chatLinkFrom("openmausbot://thread/t1?bot=b1"), "openmausbot://thread/t1?bot=b1");
  assert.equal(chatLinkFromCommandLine(["exe", launcherLink(ID)]), null);
});

function launches() {
  const timers = [];
  const queue = createAppLaunches({ later: (run) => { timers.push(run); } });
  return { queue, timers, tick: () => timers.splice(0).forEach((run) => run()) };
}

test("a launcher's link from open-url, a second launch or the first launch waits for the app, then opens its window", () => {
  const { queue, tick, timers } = launches();
  assert.equal(queue.fromArgs(["exe", launcherLink(ID)]), true);
  assert.equal(queue.fromUrl(appLink(ID)), false);
  assert.equal(queue.fromUrl(launcherLink(ID)), true);
  assert.deepEqual(queue.pending(), [ID]);
  let up = false;
  const opened = [];
  queue.attach((id) => { if (!up) return false; opened.push(id); return true; });
  assert.deepEqual(opened, []);
  assert.equal(timers.length, 1);
  tick();
  assert.equal(timers.length, 1);
  up = true;
  tick();
  assert.deepEqual(opened, [ID]);
  assert.deepEqual(queue.pending(), []);
  assert.equal(queue.fromArgs(["exe", "openmausbot://thread/t1?bot=b1"]), false);
  queue.fromUrl(launcherLink("la_0000000000000000"));
  assert.deepEqual(opened, [ID, "la_0000000000000000"]);
});
