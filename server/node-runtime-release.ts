// Official Node.js LTS archives. Digests from
// https://nodejs.org/dist/v24.14.1/SHASUMS256.txt, checked 2026-09-14.
// Pin updates require review; never fetch a mutable checksum alongside a download.
import { existsSync } from "node:fs";

export const NODE_RUNTIME_VERSION = "24.14.1";
const musl = process.platform === "linux" && (existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1"));
const DIGESTS: Record<string, string> = {
  "darwin-arm64": "25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe",
  "darwin-x64": "2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d",
  "linux-arm64": "734ff04fa7f8ed2e8a78d40cacf5ac3fc4515dac2858757cbab313eb483ba8a2",
  "linux-x64": "ace9fa104992ed0829642629c46ca7bd7fd6e76278cb96c958c4b387d29658ea",
  "win32-arm64": "a7b7c68490e4a8cde1921fe5a0cfb3001d53f9c839e416903e4f28e727b62f60",
  "win32-x64": "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70",
};

export function nodeRuntimeRelease(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const sha256 = DIGESTS[`${platform}-${arch}`];
  if (!sha256) return null;
  // Official Linux binaries require glibc, not Alpine/musl.
  if (platform === "linux" && musl) return null;
  const directory = `node-v${NODE_RUNTIME_VERSION}-${platform === "win32" ? "win" : platform}-${arch}`;
  return { directory, file: `${directory}.${platform === "win32" ? "zip" : "tar.gz"}`, sha256 };
}
