import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Capture the primary display once and encode it as a bounded JPEG. Electron's
 * renderer preview and the authenticated companion bridge deliberately share
 * this function so Windows cannot be supported by one path but silently
 * return no frame from the other.
 */
export async function captureDesktopJpeg({ getSources, getPrimaryDisplayId, quality = 65 } = {}) {
  if (typeof getSources !== "function" || typeof getPrimaryDisplayId !== "function") {
    throw new Error("desktop capture dependencies required");
  }
  const sources = await getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  const primaryId = getPrimaryDisplayId();
  const source =
    sources.find((candidate) => String(candidate.display_id) === String(primaryId)) ??
    sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("no desktop frame available");
  const frame = source.thumbnail.toJPEG(quality);
  if (!Buffer.isBuffer(frame) || frame.length < 512 || frame.length > MAX_FRAME_BYTES) {
    throw new Error("desktop capture returned an invalid image");
  }
  return frame;
}

export function desktopJpegDataUrl(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 512 || frame.length > MAX_FRAME_BYTES) {
    throw new Error("desktop capture returned an invalid image");
  }
  return `data:image/jpeg;base64,${frame.toString("base64")}`;
}

function authorized(header, token) {
  const value = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = Buffer.from(value);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startLocalScreenServer({ capture, host = HOST } = {}) {
  if (typeof capture !== "function") throw new Error("local screen capture function required");
  const token = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("pragma", "no-cache");
    if (request.method !== "GET" || request.url !== "/frame") {
      response.writeHead(404).end();
      return;
    }
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401).end();
      return;
    }
    try {
      const frame = await capture();
      if (!Buffer.isBuffer(frame) || frame.length < 512 || frame.length > MAX_FRAME_BYTES) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": frame.length,
      });
      response.end(frame);
    } catch {
      response.writeHead(503).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("local screen server did not bind");
  }
  return {
    url: `http://${host}:${address.port}/frame`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
