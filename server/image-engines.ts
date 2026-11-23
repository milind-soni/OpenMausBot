// A Cloud home's image carries engine CLIs in Node's own global npm prefix (/usr/local: the Dockerfile's
// CLOUD_HOME_ENGINES), and the app installs and updates engines into the data folder's npm prefix (tools/npm), whose bin/
// goes first on PATH. So a copy there shadows the image's even when the image's is newer, and the updater keeps
// downloading it. With OMB_IMAGE_ENGINES=1 the image's copy is used unless the data folder holds a newer copy of the same
// package (installed from Settings, or by an update a driver needs), and the updater leaves a copy that is not used alone.
// Off by default, and never on Windows: desktop installs and every other server keep today's order. Nothing is removed.
// The switch's value is `1` (the image's prefix is Node's own) or an absolute prefix.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { npmEnginesPrefix } from "./engine-roots.ts";
import { registerPathDir, unregisterPathDir } from "./env-path.ts";
import { LATEST, type EngineVersionPin } from "./engine-versions.ts";
import { isNewerVersion } from "./update-check.ts";

export const IMAGE_ENGINES_ENV = "OMB_IMAGE_ENGINES";

const VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ImageEngineOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const switchValue = (options: ImageEngineOptions) => (options.env ?? process.env)[IMAGE_ENGINES_ENV]?.trim() ?? "";

export function imageEnginesOn(options: ImageEngineOptions = {}): boolean {
  const value = switchValue(options);
  return (options.platform ?? process.platform) !== "win32" && (value === "1" || (value.startsWith("/") && isAbsolute(value)));
}

/** The switch's absolute prefix, else Node's own: `/usr/local` for the image's `/usr/local/bin/node`. */
export function imagePrefix(options: ImageEngineOptions = {}): string {
  const value = switchValue(options);
  return value.startsWith("/") ? value : dirname(dirname(process.execPath));
}

const modulesIn = (prefix: string) => join(prefix, "lib", "node_modules");

function versionIn(modules: string, pkg: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(modules, ...pkg.split("/"), "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

function packagesIn(modules: string): string[] {
  const list = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
  return list(modules).flatMap((name) => name.startsWith("@") ? list(join(modules, name)).map((inner) => `${name}/${inner}`) : name.startsWith(".") ? [] : [name]);
}

export interface SharedCopy {
  pkg: string;
  /** The image's version, null when its manifest cannot be read. */
  image: string | null;
  data: string | null;
}

/** Every package installed both in the image's prefix and the data folder's, with each copy's version. */
export function sharedCopies(baseDir: string, options: ImageEngineOptions = {}): SharedCopy[] {
  const image = modulesIn(imagePrefix(options));
  const data = modulesIn(npmEnginesPrefix(baseDir));
  if (!existsSync(image)) return [];
  return packagesIn(data).filter((pkg) => existsSync(join(image, ...pkg.split("/")))).map((pkg) => ({ pkg, image: versionIn(image, pkg), data: versionIn(data, pkg) }));
}

/** The data folder's copy is used: newer than the image's, or either version unreadable (today's order then). */
export function dataCopyWins(copy: Pick<SharedCopy, "image" | "data">): boolean {
  if (!copy.image || !copy.data || !VERSION.test(copy.image.trim()) || !VERSION.test(copy.data.trim())) return true;
  return isNewerVersion(copy.data, copy.image);
}

/** PATH order is one list for every engine, so the image's bin goes ahead of the data folder's npm bin only when no
 * package the two share is newer in the data folder: a newer copy someone installed always runs, and then an older one
 * of another engine there still does too, as today. */
export function imageBinFirst(copies: readonly SharedCopy[]): boolean {
  return copies.length > 0 && !copies.some(dataCopyWins);
}

/** Puts the image's bin ahead of the data folder's npm bin, or takes it out again; called at boot and after each npm
 * install or update. A no-op with the switch off. */
export function orderImageEngines(baseDir: string, options: ImageEngineOptions = {}): boolean {
  if (!imageEnginesOn(options)) return false;
  const bin = join(imagePrefix(options), "bin");
  const first = imageBinFirst(sharedCopies(baseDir, options));
  unregisterPathDir(bin);
  if (first) registerPathDir(bin);
  return first;
}

/** The image's version of `pkg` when the image's copy is the one that runs (`imageBinFirst`); null with the switch off,
 * when the image has none, or when the data folder's bin goes first and its copy runs instead. */
export function runningImageVersion(pkg: string, baseDir: string, options: ImageEngineOptions = {}): string | null {
  if (!imageEnginesOn(options) || !imageBinFirst(sharedCopies(baseDir, options))) return null;
  return versionIn(modulesIn(imagePrefix(options)), pkg);
}

/** The image's copy is older than this release's driver needs (its minimum), or than an exact target it pins. */
export function imageCopyTooOld(pin: Pick<EngineVersionPin, "target" | "minimum">, image: string): boolean {
  return isNewerVersion(pin.minimum, image) || (pin.target !== LATEST && isNewerVersion(pin.target, image));
}
