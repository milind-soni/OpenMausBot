// URL boundary for the in-app desktop viewer. Cloud viewers must use HTTPS;
// the one HTTP exception is the passworded noVNC server bound to loopback by
// OpenMausBot's Local VM.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function desktopViewerUrl(rawUrl) {
  if (Object.prototype.toString.call(rawUrl) !== "[object String]" || !rawUrl.trim()) {
    throw new Error("A desktop viewer address is required");
  }
  if (rawUrl.length > 16_384) throw new Error("The desktop viewer address is too long");

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The desktop viewer address is invalid");
  }

  const localHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("The desktop viewer must use HTTPS or the local VM address");
  }
  if (url.username || url.password) {
    throw new Error("Desktop viewer credentials must not use URL user info");
  }
  return url;
}

function sameDesktopViewerOrigin(rawUrl, origin) {
  try {
    return desktopViewerUrl(rawUrl).origin === origin;
  } catch {
    return false;
  }
}

module.exports = { desktopViewerUrl, sameDesktopViewerOrigin };
