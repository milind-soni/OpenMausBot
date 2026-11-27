function frameKey(frame) {
  if (!Number.isInteger(frame?.processId) || !Number.isInteger(frame?.routingId)) return null;
  return `${frame.processId}:${frame.routingId}`;
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function createDisplayMediaGuard({ now = Date.now, ttlMs = 5_000 } = {}) {
  const intents = new Map();

  function prune() {
    const current = now();
    for (const [key, expiresAt] of intents) {
      if (expiresAt < current) intents.delete(key);
    }
  }

  return Object.freeze({
    begin(frame) {
      const key = frameKey(frame);
      if (!key) return false;
      prune();
      intents.set(key, now() + ttlMs);
      return true;
    },

    consume(request, expectedOrigin) {
      const key = frameKey(request?.frame);
      if (!key) return false;
      const expiresAt = intents.get(key);
      intents.delete(key);
      const requestOrigin = originOf(request.securityOrigin);
      const allowedOrigin = originOf(expectedOrigin);

      return Boolean(
        expiresAt !== undefined &&
          expiresAt >= now() &&
          request.userGesture === true &&
          request.videoRequested === true &&
          request.audioRequested === false &&
          requestOrigin !== null &&
          allowedOrigin !== null &&
          requestOrigin === allowedOrigin,
      );
    },
  });
}

function selectCaptureSource({ sources, host, primaryDisplayId }) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  if (host === "wayland") return sources.length === 1 ? sources[0] : null;
  if (host === "x11") {
    const exact = sources.find(
      (source) =>
        source.display_id !== undefined &&
        primaryDisplayId !== undefined &&
        String(source.display_id) === String(primaryDisplayId),
    );
    // Some X11 backends omit or misreport display_id: a single source is unambiguous, but never guess among several.
    return exact ?? (sources.length === 1 ? sources[0] : null);
  }
  if (host === "darwin") return sources[0];
  return null;
}

// Electron may throw synchronously when an empty response rejects a video request (expected after a portal cancel):
// return the error rather than letting it escape as an unhandled rejection.
function invokeDisplayMediaCallback(callback, response) {
  try {
    callback(response);
    return null;
  } catch (error) {
    return error;
  }
}

module.exports = {
  createDisplayMediaGuard,
  frameKey,
  invokeDisplayMediaCallback,
  originOf,
  selectCaptureSource,
};
