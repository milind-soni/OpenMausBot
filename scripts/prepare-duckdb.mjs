// Stage the DuckDB binding outside ASAR, one tree per platform and CPU:
// dist-native/duckdb/<platform>-<arch>/node_modules/@duckdb/{node-api,
// node-bindings,node-bindings-<platform>-<arch>}. The packaged app ships no
// node_modules (the server is an esbuild bundle), so the binding travels as an
// extraResources tree that server/data/engine.ts loads through createRequire;
// the Docker build stages the same way and points OMB_DUCKDB_DIR at it.
//
// Each tree holds exactly the pinned version from package.json: a binding and
// its libduckdb must come from the same release, and the extension directory
// is keyed by that version too. The mac platform packages carry one universal
// libduckdb.dylib (117 MB) for both arches; each single-arch app keeps only
// its slice (57 MB) and re-signs it, electron-builder then signs it again with
// the app's identity. When the host's install lacks the other mac arch's
// package, the exact version is fetched with npm pack into a cache.
import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCuaMacArches } from "./cua-mac-arches.mjs";
import { LIPO_ARCH, isMachO, machOArchs, writeThinMachO } from "./mac-thin.mjs";

const run = promisify(execFile);
const SCOPE = "@duckdb";
export const DUCKDB_PACKAGES = ["node-api", "node-bindings"];
export const LIBRARY_FILE = { darwin: "libduckdb.dylib", linux: "libduckdb.so", win32: "duckdb.dll" };

export function platformPackage(platform, arch) {
  return `node-bindings-${platform}-${arch}`;
}

/** The exact `x.y.z-r.n` package.json pins; a range would let the binding
 *  and the pre-baked extensions drift apart. */
export function pinnedDuckdbVersion(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pin = manifest.dependencies?.[`${SCOPE}/node-api`];
  if (!pin || !/^\d+\.\d+\.\d+-r\.\d+$/.test(pin)) {
    throw new Error(`package.json must pin ${SCOPE}/node-api to an exact x.y.z-r.n version; found ${pin ?? "nothing"}`);
  }
  return pin;
}

function packageVersion(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
}

/** Where the install put an @duckdb package. pnpm links only node-api at
 *  the top of node_modules; node-bindings sits beside it in the store, and
 *  the platform packages beside node-bindings. */
export function installedPackage(nodeModules, name) {
  const candidates = [join(nodeModules, SCOPE, name)];
  try {
    const api = realpathSync(join(nodeModules, SCOPE, "node-api"));
    candidates.push(join(api, "..", name));
    const bindings = realpathSync(join(api, "..", "node-bindings"));
    candidates.push(join(bindings, "..", name));
  } catch {
    // no node-api at all: the loop below reports it
  }
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (statSync(real).isDirectory()) return real;
    } catch {
      // not this candidate
    }
  }
  return null;
}

/** Fetch the exact platform package the host never installs (the other mac
 *  arch) into the cache, once per version. */
export async function packedPackage(name, version, cache) {
  const directory = join(cache, `${name}-${version}`);
  if (existsSync(join(directory, "package.json")) && packageVersion(directory) === version) return directory;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  console.log(`Fetching ${SCOPE}/${name}@${version} with npm pack…`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await run(npm, ["pack", `${SCOPE}/${name}@${version}`, "--pack-destination", directory, "--silent"], { cwd: directory, timeout: 600_000, shell: process.platform === "win32" });
  const tarball = join(directory, stdout.trim().split(/\r?\n/).pop());
  await run("tar", ["-xzf", tarball, "-C", directory, "--strip-components=1"]);
  rmSync(tarball, { force: true });
  return directory;
}

/** The trees to stage on this host: both mac arches on macOS (each app is
 *  single-arch), x64 elsewhere, matching electron-builder.yml. */
export function targetsFor(platform = process.platform, env = process.env) {
  if (platform === "darwin") return resolveCuaMacArches(env).map((arch) => ({ platform, arch }));
  return [{ platform, arch: "x64" }];
}

function requireRegularFile(file) {
  let details;
  try {
    details = lstatSync(file);
  } catch {
    throw new Error(`DuckDB resource is missing: ${file}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`DuckDB resource must be a regular file: ${file}`);
}

/** A staged or packaged tree is complete, pinned, and holds only this
 *  platform's and arch's native code. */
export async function verifyDuckdbTree(directory, platform, arch, version) {
  const scope = join(directory, "node_modules", SCOPE);
  const native = platformPackage(platform, arch);
  for (const name of [...DUCKDB_PACKAGES, native]) {
    requireRegularFile(join(scope, name, "package.json"));
    const found = packageVersion(join(scope, name));
    if (version && found !== version) throw new Error(`${SCOPE}/${name} in ${directory} is ${found}; package.json pins ${version}`);
  }
  requireRegularFile(join(scope, "node-api", "lib", "index.js"));
  requireRegularFile(join(scope, "node-bindings", "duckdb.js"));
  const library = LIBRARY_FILE[platform];
  if (!library) throw new Error(`No DuckDB library name for platform ${platform}`);
  const binary = join(scope, native, "duckdb.node");
  const shared = join(scope, native, library);
  requireRegularFile(binary);
  requireRegularFile(shared);
  if (platform === "darwin") {
    const wanted = LIPO_ARCH[arch];
    if (!wanted) throw new Error(`Unsupported macOS architecture for DuckDB: ${arch}`);
    for (const file of [binary, shared]) {
      if (!(await isMachO(file))) throw new Error(`${file} is not a Mach-O file`);
      const archs = await machOArchs(file);
      if (archs.join(" ") !== wanted) throw new Error(`${file} is [${archs.join(" ")}], must be exactly ${wanted}`);
    }
  }
}

export async function stageDuckdb({
  root,
  nodeModules = join(root, "node_modules"),
  stage = join(root, "dist-native", "duckdb"),
  targets = targetsFor(),
  cache = join(nodeModules, ".cache", "openmausbot", "duckdb"),
  pack = packedPackage,
  sign = process.platform === "darwin",
  log = console.log,
}) {
  const version = pinnedDuckdbVersion(root);
  const staged = [];
  for (const { platform, arch } of targets) {
    const destination = join(stage, `${platform}-${arch}`);
    rmSync(destination, { recursive: true, force: true });
    const scope = join(destination, "node_modules", SCOPE);
    mkdirSync(scope, { recursive: true });
    for (const name of [...DUCKDB_PACKAGES, platformPackage(platform, arch)]) {
      let source = installedPackage(nodeModules, name);
      if (!source) {
        if (!name.startsWith("node-bindings-")) throw new Error(`${SCOPE}/${name} is not installed; run pnpm install`);
        source = await pack(name, version, cache);
      }
      const found = packageVersion(source);
      if (found !== version) throw new Error(`${SCOPE}/${name} at ${source} is ${found}; package.json pins ${version}`);
      cpSync(source, join(scope, name), { recursive: true, dereference: true });
    }
    if (platform === "darwin") {
      const native = join(scope, platformPackage(platform, arch));
      for (const file of ["duckdb.node", LIBRARY_FILE.darwin]) {
        const path = join(native, file);
        await writeThinMachO(path, path, LIPO_ARCH[arch]);
        // Apple's signature covered the universal file; the slice needs its
        // own or dlopen refuses it. electron-builder re-signs with the app's identity.
        if (sign) await run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
      }
    }
    await verifyDuckdbTree(destination, platform, arch, version);
    staged.push(destination);
    log?.(`Staged DuckDB ${version} for ${platform}-${arch} at ${destination}`);
  }
  return staged;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await stageDuckdb({ root: join(dirname(fileURLToPath(import.meta.url)), "..") });
}
