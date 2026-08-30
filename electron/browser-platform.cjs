"use strict";

/**
 * The built-in browser depends on Electron's production renderer sandbox.
 * Electron 43 currently exits before ready on the Windows hosts we can verify
 * (electron/electron#51761), so Windows stays fail-closed until that sandboxed
 * fixture can become a blocking CI check again.
 */
function browserSurfaceSupported(platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

module.exports = { browserSurfaceSupported };
