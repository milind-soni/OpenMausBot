// Streams an archive of /data to or from an https URL, hashing it on the way. Plain http only for a test Admin on this
// machine's loopback (protocol.ts checkTransferUrl).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface Transfer {
  /** Writes the body at `url` to `file`; refuses more than `maxBytes`. */
  download(url: string, headers: Record<string, string>, file: string, maxBytes: number): Promise<{ bytes: number }>;
  /** PUTs `file` to `url`. */
  upload(url: string, headers: Record<string, string>, file: string): Promise<{ bytes: number; sha256: string }>;
}

function requester(url: URL) {
  return url.protocol === "https:" ? httpsRequest : httpRequest;
}

function counter(limit: number, onChunk: (chunk: Buffer) => void) {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) return done(new Error(`the archive is larger than the ${Math.floor(limit / 1e9)} GB free on this server`));
      onChunk(chunk);
      done(null, chunk);
    },
  });
  return { stream, bytes: () => bytes };
}

export const httpTransfer: Transfer = {
  download(target, headers, file, maxBytes) {
    const url = new URL(target);
    return new Promise((resolve, reject) => {
      const req = requester(url)(url, { method: "GET", headers, timeout: 120_000 }, (res: IncomingMessage) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume();
          reject(new Error(`the archive's address answered ${res.statusCode}`));
          return;
        }
        const count = counter(maxBytes, () => {});
        pipeline(res, count.stream, createWriteStream(file, { mode: 0o600 })).then(() => resolve({ bytes: count.bytes() }), reject);
      });
      req.on("timeout", () => req.destroy(new Error("the archive's address stopped answering")));
      req.on("error", reject);
      req.end();
    });
  },

  upload(target, headers, file) {
    const url = new URL(target);
    const size = statSync(file).size;
    const hash = createHash("sha256");
    return new Promise((resolve, reject) => {
      const req = requester(url)(url, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/gzip", "content-length": String(size) },
        timeout: 120_000,
      }, (res: IncomingMessage) => {
        res.resume();
        res.on("end", () => ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300
          ? resolve({ bytes: size, sha256: hash.digest("hex") })
          : reject(new Error(`the Admin answered ${res.statusCode} to the upload`))));
      });
      req.on("timeout", () => req.destroy(new Error("the Admin stopped answering the upload")));
      req.on("error", reject);
      const count = counter(Number.MAX_SAFE_INTEGER, (chunk) => hash.update(chunk));
      pipeline(createReadStream(file), count.stream, req).catch(reject);
    });
  },
};
