// The workerd runtime (Apache-2.0) that runs app operations, fetched on first use from its official GitHub release and
// pinned by version and SHA-256. The gzip is verified before it is unpacked, and the binary again on every reuse when
// its own digest is pinned; nothing unverified is ever made executable or renamed into place.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const WORKERD_VERSION = "1.20261110.1";
/** The newest compatibility date every pinned build accepts. */
export const WORKERD_COMPATIBILITY_DATE = "2026-08-01";

export type RuntimePlatform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "win32-x64";

export interface RuntimeAsset {
  /** The release asset's name. */
  name: string;
  /** SHA-256 of the .gz as published (GitHub's asset digest). */
  sha256: string;
  /** SHA-256 of the unpacked binary, where it has been measured. */
  binarySha256: string | null;
  executable: string;
}

export const WORKERD_ASSETS: Readonly<Record<RuntimePlatform, RuntimeAsset>> = Object.freeze({
  "darwin-arm64": { name: "workerd-darwin-arm64.gz", sha256: "9872aa5597a21a57b1f912722b51946daab8ef6ab2ab23ca8a93c7130a71665b", binarySha256: "f08ed8b7be3588cc7393b274e7278bee3125a1015ed3e214293e5e75088dd5b1", executable: "workerd" },
  "darwin-x64": { name: "workerd-darwin-64.gz", sha256: "b1797ad42a76554105b014bef03dc6404abc28ef8f4032d6143dcbe8246e8812", binarySha256: null, executable: "workerd" },
  "linux-x64": { name: "workerd-linux-64.gz", sha256: "6d710b0f310e21383ee52fe8c71aa8cca3f51c2c04a48ec03e56868e97e1e65d", binarySha256: null, executable: "workerd" },
  "linux-arm64": { name: "workerd-linux-arm64.gz", sha256: "ebc14c6dcce6c52515aecaf63bda83c9dc379515f589c9f16b01436cb4ecf867", binarySha256: null, executable: "workerd" },
  "win32-x64": { name: "workerd-windows-64.gz", sha256: "9bb268b631f2881b971872cd2a990e685dabbdd51bee8bc14dd59325381ccde5", binarySha256: null, executable: "workerd.exe" },
});

export function runtimePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): RuntimePlatform | null {
  const key = `${platform}-${arch}`;
  return key in WORKERD_ASSETS ? key as RuntimePlatform : null;
}

export function releaseUrl(version: string, asset: RuntimeAsset): string {
  return `https://github.com/cloudflare/workerd/releases/download/v${version}/${asset.name}`;
}

export type RuntimeFetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface EnsureRuntimeOptions {
  dataDir: string;
  fetch: RuntimeFetch;
  platform?: RuntimePlatform | null;
  version?: string;
  assets?: Readonly<Record<RuntimePlatform, RuntimeAsset>>;
  /** Largest download accepted, in bytes. */
  maxBytes?: number;
}

export class RuntimeUnavailable extends Error {}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const inflight = new Map<string, Promise<string>>();

/** The path of a verified workerd binary for this computer, downloading it once. Concurrent callers share one download. */
export function ensureRuntime(options: EnsureRuntimeOptions): Promise<string> {
  const version = options.version ?? WORKERD_VERSION;
  const platform = options.platform === undefined ? runtimePlatform() : options.platform;
  if (!platform) return Promise.reject(new RuntimeUnavailable(`App operations do not run on ${process.platform}-${process.arch}.`));
  const asset = (options.assets ?? WORKERD_ASSETS)[platform];
  const folder = join(options.dataDir, "runtimes", "workerd", version);
  const binary = join(folder, asset.executable);
  const key = binary;
  const running = inflight.get(key);
  if (running) return running;
  const work = (async () => {
    if (existsSync(binary)) {
      if (!asset.binarySha256 || sha256(readFileSync(binary)) === asset.binarySha256) return binary;
      rmSync(binary, { force: true });
    }
    const response = await options.fetch(releaseUrl(version, asset));
    if (!response.ok) throw new RuntimeUnavailable(`The app runtime could not be downloaded (HTTP ${response.status}).`);
    const packed = new Uint8Array(await response.arrayBuffer());
    if (packed.byteLength > (options.maxBytes ?? 128 * 1024 * 1024)) throw new RuntimeUnavailable("The app runtime download was larger than expected.");
    if (sha256(packed) !== asset.sha256) throw new RuntimeUnavailable("The app runtime download did not match its pinned checksum.");
    const unpacked = gunzipSync(packed);
    if (asset.binarySha256 && sha256(unpacked) !== asset.binarySha256) throw new RuntimeUnavailable("The unpacked app runtime did not match its pinned checksum.");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const staged = join(folder, `.${asset.executable}.${randomUUID()}.tmp`);
    try {
      writeFileSync(staged, unpacked, { mode: 0o700 });
      chmodSync(staged, 0o755);
      renameSync(staged, binary);
    } finally {
      rmSync(staged, { force: true });
    }
    return binary;
  })();
  inflight.set(key, work);
  return work.finally(() => inflight.delete(key));
}
