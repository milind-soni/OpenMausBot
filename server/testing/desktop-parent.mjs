// The desktop app's private parent port, for a server a test or the launcher's desktop mode starts as if Electron had:
// the server runs as Electron's utility process, and only what the app itself would send crosses.
// OMB_TEST_DESKTOP_OWNER_TOKEN (with OMB_DESKTOP_PARENT=1): the test's owner capability.
// OMB_TEST_DESKTOP_PAGES_ACCESS: the published pages' access the app hands over for a signed-in MausBot account, as JSON.
// OMB_TEST_DESKTOP_CUA_CONNECTION: a file holding the app's driver record; the app hands it to its own server, and again
// each time the file changes, as the real app does each time its driver changes.
import { readFileSync, unwatchFile, watchFile } from "node:fs";

const token = process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
const pages = process.env.OMB_TEST_DESKTOP_PAGES_ACCESS;
const cuaFile = process.env.OMB_TEST_DESKTOP_CUA_CONNECTION;
delete process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
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
        if (token) queueMicrotask(() => listener({ data: { type: "openmausbot:desktop-mutation-token", token } }));
        if (pages) queueMicrotask(() => listener({ data: { type: "openmausbot:included-pages", access: JSON.parse(pages) } }));
        if (cuaFile) queueMicrotask(() => listener({ data: cuaGrant() }));
      },
      postMessage() {},
    },
  });
}
