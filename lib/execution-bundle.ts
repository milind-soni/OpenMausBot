import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { VERSION } from "../runner/security.mjs";
import { localDataDir } from "./localRealtime";

type RunnerBundle = { version: string; sha256: string; files: { path: string; content: string; sha256: string }[] };
export type ExecutionRunnerRelease = {
  manifest: { version: string; channel: "stable"; protocolVersion: 1; nodeMajor: 24; files: { path: string; sha256: string; bytes: number }[] };
  signature: string;
};
let published: Promise<RunnerBundle> | undefined;

export function executionRunnerBundle(): Promise<RunnerBundle> {
  if (published) return published;
  published = (async () => {
    const root = path.join(process.cwd(), "runner");
    if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error("Only reviewed stable runner releases may be published");
    const files: RunnerBundle["files"] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!/^[a-zA-Z0-9_-]+\.mjs$/.test(entry.name)) continue;
      if (!entry.isFile()) throw new Error("Runner distribution must contain regular source files only");
      const bytes = await readFile(path.join(root, entry.name));
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Runner distribution must be UTF-8");
      files.push({ path: entry.name, content, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    if (!files.some(file => file.path === "cli.mjs") || !files.some(file => file.path === "security.mjs")) throw new Error("Runner distribution is incomplete");
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const sha256 = createHash("sha256").update(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))).digest("hex");
    return { version: VERSION, sha256, files };
  })().catch(error => { published = undefined; throw error; });
  return published;
}

function runnerSigningKey() {
  const root = localDataDir(), file = path.join(root, "runner-signing.key");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const load = () => {
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error("Runner signing key must be an owner-only regular file");
      const key = createPrivateKey(readFileSync(descriptor));
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Runner signing key must be Ed25519");
      return key;
    } finally { closeSync(descriptor); }
  };
  try { return load(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = path.join(root, `.runner-signing-${randomUUID()}`);
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
      writeFileSync(descriptor, key); fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    try { linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporary); }
  return load();
}

export function executionRunnerPublicKey(): string {
  return createPublicKey(runnerSigningKey()).export({ type: "spki", format: "pem" }).toString();
}

export async function executionRunnerRelease(): Promise<ExecutionRunnerRelease> {
  const bundle = await executionRunnerBundle();
  const manifest: ExecutionRunnerRelease["manifest"] = {
    version: bundle.version, channel: "stable", protocolVersion: 1, nodeMajor: 24,
    files: bundle.files.map(file => ({ path: `runner/${file.path}`, sha256: file.sha256, bytes: Buffer.byteLength(file.content, "utf8") })),
  };
  return { manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), runnerSigningKey()).toString("base64") };
}

export async function executionRunnerResource(resource: string[]): Promise<Response> {
  const bundle = await executionRunnerBundle();
  const latest = resource.length === 1 && resource[0] === "latest.json";
  if (latest || resource.length === 2 && resource[0] === bundle.version && resource[1] === "manifest.json") {
    return Response.json(await executionRunnerRelease(), { headers: { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } });
  }
  if (resource.length === 3 && resource[0] === bundle.version && resource[1] === "runner") {
    const file = bundle.files.find(file => file.path === resource[2]);
    if (file) return new Response(file.content, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=60", ETag: `"${file.sha256}"`, "X-Content-Type-Options": "nosniff" } });
  }
  return Response.json({ error: "Runner release resource not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
