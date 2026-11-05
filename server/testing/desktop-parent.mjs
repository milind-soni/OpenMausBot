// The desktop app's private parent port, for a server a test or the launcher's desktop mode starts as if Electron had:
// the server runs as Electron's utility process, and only what the app itself would send crosses.
// OMB_TEST_DESKTOP_OWNER_TOKEN (with OMB_DESKTOP_PARENT=1): the test's owner capability.
// OMB_TEST_DESKTOP_COMPANION_TOKEN: the capability the app's companion proxy sends with a paired phone's calls.
// OMB_TEST_DESKTOP_PHONE_SECRET_KEY (a JSON phone-secret-key message) and OMB_TEST_DESKTOP_SAVED_KEYS (a file): the app
// holds the phone-secret key and answers each save by appending {target, value} to the file, as its credential store would.
// OMB_TEST_DESKTOP_PAGES_ACCESS: the published pages' access the app hands over for a signed-in MausBot account, as JSON.
// OMB_TEST_DESKTOP_CUA_CONNECTION: a file holding the app's driver record; the app hands it to its own server, and again
// each time the file changes, as the real app does each time its driver changes.
import { appendFileSync, readFileSync, unwatchFile, watchFile } from "node:fs";

const token = process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
const companionToken = process.env.OMB_TEST_DESKTOP_COMPANION_TOKEN;
const secretKey = process.env.OMB_TEST_DESKTOP_PHONE_SECRET_KEY;
const savedKeys = process.env.OMB_TEST_DESKTOP_SAVED_KEYS;
const pages = process.env.OMB_TEST_DESKTOP_PAGES_ACCESS;
const cuaFile = process.env.OMB_TEST_DESKTOP_CUA_CONNECTION;
delete process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
delete process.env.OMB_TEST_DESKTOP_COMPANION_TOKEN;
delete process.env.OMB_TEST_DESKTOP_PHONE_SECRET_KEY;
delete process.env.OMB_TEST_DESKTOP_SAVED_KEYS;
delete process.env.OMB_TEST_DESKTOP_PAGES_ACCESS;
delete process.env.OMB_TEST_DESKTOP_CUA_CONNECTION;

const cuaGrant = () => {
  let connection = null;
  try {
    connection = JSON.parse(readFileSync(cuaFile, "utf8"));
  } catch {}
  return { type: "openmausbot:local-computer", connection };
};

if (token || cuaFile) {
  const listeners = [];
  if (cuaFile) {
    watchFile(cuaFile, { interval: 25, persistent: false }, () => {
      const grant = cuaGrant();
      for (const listener of listeners) listener({ data: grant });
    });
    process.once("exit", () => unwatchFile(cuaFile));
  }
  Object.defineProperty(process, "parentPort", {
    value: {
      on(event, listener) {
        if (event !== "message") return;
        listeners.push(listener);
        if (token) queueMicrotask(() => listener({ data: { type: "openmausbot:desktop-mutation-token", token, companionToken } }));
        if (secretKey) queueMicrotask(() => listener({ data: JSON.parse(secretKey) }));
        if (pages) queueMicrotask(() => listener({ data: { type: "openmausbot:included-pages", access: JSON.parse(pages) } }));
        if (cuaFile) queueMicrotask(() => listener({ data: cuaGrant() }));
      },
      postMessage(message) {
        if (message?.type !== "openmausbot:phone-secret-save" || !savedKeys) return;
        appendFileSync(savedKeys, JSON.stringify({ target: message.target, value: message.value }) + "\n");
        queueMicrotask(() => { for (const listener of listeners) listener({ data: { type: "openmausbot:phone-secret-save-result", requestId: message.requestId, ok: true } }); });
      },
    },
  });
}
