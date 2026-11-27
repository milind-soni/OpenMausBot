// Reading an engine CLI's `--version` probe and comparing dotted versions.

/** Hermes writes its whole `--version` banner to stderr with an empty stdout. */
export function versionFromProbe(stdout: string | undefined, stderr: string | undefined): string | null {
  const out = (stdout ?? "").trim();
  if (out) return out;
  const err = (stderr ?? "").trim().split(/\r\n|\n|\r/, 1)[0]?.trim() ?? "";
  return err || null;
}

/** A CLI path that runs another program answers --version as that program: an install command pasted as the path
 * (`curl https://cursor.com/install -fsS | bash`) runs curl, whose `--version` wins over its other arguments. The
 * registry drops such a path once the engine's own CLI is installed, so the person never has to. */
export function notThisCli(cli: string, name: string): string {
  return `\`${cli}\` is not ${name}'s CLI: it answered --version as another program.`;
}

export type VersionTriple = readonly [number, number, number];

export function parseVersionTriple(value: string): VersionTriple | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(installed: VersionTriple, floor: VersionTriple): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (installed[i] !== floor[i]) return installed[i] > floor[i];
  }
  return true;
}

interface SemanticVersion {
  core: string[];
  prerelease: string[];
}

export function parseSemVer(value: string): SemanticVersion | null {
  const match = /^(\d+\.\d+\.\d+)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value.trim());
  if (!match) return null;
  const core = match[1].split(".");
  const prerelease = match[2]?.split(".") ?? [];
  if ([...core, ...prerelease].some((part) => /^0\d+$/.test(part))) return null;
  return { core, prerelease };
}

function compareIdentifiers(left: string[], right: string[]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const a = left[i], b = right[i];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

export function semVerAtLeast(installed: string, minimum: string): boolean {
  const version = parseSemVer(installed), floor = parseSemVer(minimum);
  if (!version || !floor) return false;
  const core = compareIdentifiers(version.core, floor.core);
  if (core !== 0) return core > 0;
  if (!version.prerelease.length) return true;
  return floor.prerelease.length > 0 && compareIdentifiers(version.prerelease, floor.prerelease) >= 0;
}
