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
