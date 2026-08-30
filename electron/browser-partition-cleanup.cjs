"use strict";

/** Clear every credential-bearing part of an Electron Session. Connection
 * close is best effort, but storage/cache/auth failures are authoritative: a
 * lifecycle ACK must not claim success while any of them may remain. */
async function clearBrowserPartitionSession(session) {
  try {
    await session.closeAllConnections();
  } catch {}
  await session.clearStorageData();
  await session.clearCache();
  await session.clearAuthCache();
  try {
    await session.closeAllConnections();
  } catch {}
}

module.exports = { clearBrowserPartitionSession };
