// Which page is asking. The main window shows either the local server's UI or
// a paired remote server's UI; anything that touches THIS computer (screen,
// files, logins, helpers, updater, local control) answers only the former.
// main.mjs sets the local origin once it knows the port; every IPC module
// wraps its handlers with localOnly(). Pure, so it is unit-tested.
let localOrigin = null;

function setLocalOrigin(origin) {
  localOrigin = typeof origin === "string" && origin ? origin : null;
}

function getLocalOrigin() {
  return localOrigin;
}

/** The origin of the frame that sent an IPC message, or null when unknown. */
function senderOrigin(event) {
  const url = event?.senderFrame?.url ?? (typeof event?.sender?.getURL === "function" ? event.sender.getURL() : "");
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isLocalSender(event) {
  // Until the local origin is known nothing is local: fail closed.
  return localOrigin !== null && senderOrigin(event) === localOrigin;
}

/** Wrap an ipcMain.handle handler so a page that is not the local server's
 * UI gets a clear error instead of an answer. */
function localOnly(channel, handler) {
  return (event, ...args) => {
    if (!isLocalSender(event)) throw new Error(`${channel} is only available while using the local server`);
    return handler(event, ...args);
  };
}

/** Same for ipcMain.on / sendSync: answer `denied` and stop. */
function localOnlySync(channel, handler, denied = false) {
  return (event, ...args) => {
    if (!isLocalSender(event)) {
      event.returnValue = denied;
      return;
    }
    return handler(event, ...args);
  };
}

module.exports = { getLocalOrigin, isLocalSender, localOnly, localOnlySync, senderOrigin, setLocalOrigin };
