"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Packaged builds transport the browser master token over Electron's
 * private utility-process port. Remove any descriptor left by an older build
 * before the child starts so it cannot become a same-user shell bypass. */
function removeBrowserConnectionDescriptor({ userData, fileSystem = fs }) {
  const descriptorPath = path.join(userData, "browser-connection.json");
  try {
    fileSystem.unlinkSync(descriptorPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function postBrowserConnection(proc, connection) {
  proc.postMessage({ type: "openmausbot:browser-connection", connection: connection ?? null });
}

module.exports = { postBrowserConnection, removeBrowserConnectionDescriptor };
