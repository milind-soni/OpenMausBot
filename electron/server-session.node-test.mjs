import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";

import { installServerSessions, reportOwnListeners, targetsServer } from "./server-session.mjs";

const SERVER_PORT = 48799;

function fakeSession() {
  const hooks = {};
  return {
    hooks,
    webRequest: {
      onBeforeSendHeaders: (handler) => { hooks.headers = handler; },
      onBeforeRequest: (handler) => { hooks.request = handler; },
    },
  };
}

function install(token = "a".repeat(43)) {
  const listeners = [];
  const app = { on: (event, handler) => { if (event === "session-created") listeners.push(handler); } };
  const defaultSession = fakeSession();
  let current = token;
  installServerSessions({ app, defaultSession, serverPort: () => SERVER_PORT, ownerToken: () => current });
  return {
    defaultSession,
    setToken: (value) => { current = value; },
    created: (session) => { for (const listener of listeners) listener(session); return session; },
  };
}

const sendHeaders = (session, url) => new Promise((resolve) => session.hooks.headers({ url, requestHeaders: { Accept: "*/*" } }, (result) => resolve(result.requestHeaders)));
const request = (session, url) => new Promise((resolve) => session.hooks.request({ url }, (result) => resolve(result.cancel)));

test("the app window's own requests to the server carry the owner header on http and WebSocket alike", async () => {
  const { defaultSession, setToken } = install();
  for (const url of [`http://127.0.0.1:${SERVER_PORT}/api/bots`, `ws://127.0.0.1:${SERVER_PORT}/api/desktop-viewer/local/shared/websockify`]) {
    assert.equal((await sendHeaders(defaultSession, url))["X-OpenMausBot-Desktop-Owner"], "a".repeat(43), url);
  }
  for (const url of [`http://127.0.0.1:${SERVER_PORT + 1}/`, `https://127.0.0.1:${SERVER_PORT}/`, "https://example.com/", `http://localhost:${SERVER_PORT}/`, "not a url"]) {
    assert.equal((await sendHeaders(defaultSession, url))["X-OpenMausBot-Desktop-Owner"], undefined, url);
  }
  setToken(null);
  assert.equal((await sendHeaders(defaultSession, `http://127.0.0.1:${SERVER_PORT}/api/bots`))["X-OpenMausBot-Desktop-Owner"], undefined);
});

test("no session but the app window's may reach the server, in any spelling of this machine", async () => {
  const { defaultSession, created } = install();
  const viewer = created(fakeSession());
  for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "app.localhost", "[::1]", "[::ffff:127.0.0.1]", "0.0.0.0"]) {
    for (const scheme of ["http", "ws", "https", "wss"]) {
      assert.equal(await request(viewer, `${scheme}://${host}:${SERVER_PORT}/api/bots`), true, `${scheme} ${host}`);
    }
  }
  for (const url of [`http://127.0.0.1:6080/vnc.html`, "https://desktop.example/vnc.html", `http://10.0.0.5:${SERVER_PORT}/`, "data:text/html,x"]) {
    assert.equal(await request(viewer, url), false, url);
  }
  created(defaultSession);
  assert.equal(defaultSession.hooks.request, undefined, "the app window's own session is never cancelled");
});

test("every session main creates gets the guard before it loads anything", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const install = main.indexOf("installServerSessions({");
  assert.ok(install > 0);
  assert.equal(main.indexOf("installServerSessions({", install + 1), -1);
  assert.ok(main.indexOf("await showHome();", install) > install, "installed before the first window");
  assert.doesNotMatch(main, /onBeforeSendHeaders/, "the owner header is added in one place");
  assert.equal(targetsServer(`http://2130706433:${SERVER_PORT}/`, SERVER_PORT), true);
});

test("the server hears about every port this app listens on, and about new ones as they open", async () => {
  const messages = [];
  reportOwnListeners({ postMessage: (message) => messages.push(message) }, [8810]);
  assert.equal(messages.at(-1).type, "openmausbot:own-listeners");
  assert.ok(messages.at(-1).ports.includes(8810));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.ok(messages.at(-1).ports.includes(server.address().port));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
