import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { SCRCPY_SERVER } from "./scrcpy-wire.ts";

export type ScrcpyServerOptions = {
  source?: typeof SCRCPY_SERVER;
  fetch?: typeof fetch;
};

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;

const inFlight = new Map<string, Promise<string>>();

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The path of the pinned scrcpy server file under `dataDir`, downloaded first unless a verified copy is already there. */
export function ensureScrcpyServer(dataDir: string, options: ScrcpyServerOptions = {}): Promise<string> {
  const source = options.source ?? SCRCPY_SERVER;
  const file = join(dataDir, "scrcpy", `scrcpy-server-v${source.version}`);
  let staging = inFlight.get(file);
  if (!staging) {
    staging = stage(file, source, options.fetch ?? fetch).finally(() => inFlight.delete(file));
    inFlight.set(file, staging);
  }
  return staging;
}

async function stage(file: string, source: typeof SCRCPY_SERVER, fetchImpl: typeof fetch): Promise<string> {
  const saved = await savedDigest(file);
  if (saved === source.sha256) return file;
  if (saved !== undefined) await rm(file, { force: true });
  // A person reads this as a WebSocket close reason, which RFC 6455 cuts at 123 bytes: the cause and the path come before the URL.
  const failed = (cause: string) => `Download failed (${cause}): save scrcpy-server ${source.version} as ${file} from ${source.url}.`;
  let bytes: Buffer;
  try {
    bytes = await download(source.url, fetchImpl);
  } catch (error) {
    throw new Error(failed(error instanceof Error ? error.message : String(error)));
  }
  const digest = sha256(bytes);
  if (digest !== source.sha256) {
    throw new Error(`${failed("wrong SHA-256")} The download has SHA-256 ${digest}, not the expected ${source.sha256}, so it was not saved.`);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, bytes, { mode: 0o600 });
  return file;
}

async function savedDigest(file: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read ${file}, so it was left as it is: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD_BYTES) throw new Error("the file is larger than 4 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
