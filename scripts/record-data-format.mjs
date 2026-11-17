// Writes server/data-format-released.json: the data formats the release being prepared writes and reads, which the
// next release's changes are held against (server/data-format.test.ts). prepare-release.yml runs it with the version bump.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);

/** The numbers of `export const DATA_FORMAT = { writes: N, reads: M }` in server/data-format.ts. */
export function declaredDataFormat(source) {
  const match = /export const DATA_FORMAT = \{ writes: (\d+), reads: (\d+) \} as const;/.exec(source);
  if (!match) throw new Error("server/data-format.ts no longer declares DATA_FORMAT as { writes: N, reads: M }");
  return { writes: Number(match[1]), reads: Number(match[2]) };
}

export function releasedRecord(version, source) {
  return `${JSON.stringify({ version, ...declaredDataFormat(source) }, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  writeFileSync(new URL("server/data-format-released.json", ROOT), releasedRecord(version, readFileSync(new URL("server/data-format.ts", ROOT), "utf8")));
}
