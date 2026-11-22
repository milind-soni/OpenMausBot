// Writes server/data-format-released.json: the data formats the release being prepared writes and reads, which the
// next release's changes are held against (server/data-format.test.ts). prepare-release.yml runs it with the version bump.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const FORMAT_SOURCE = new URL("server/data-format.ts", ROOT);
const FORMAT_DECLARATION = /export const DATA_FORMAT = \{ writes: (\d+), reads: (\d+) \} as const;/;

/** The numbers of `export const DATA_FORMAT = { writes: N, reads: M }` in server/data-format.ts. */
export function declaredDataFormat(source) {
  const match = FORMAT_DECLARATION.exec(source);
  if (!match) throw new Error("server/data-format.ts no longer declares DATA_FORMAT as { writes: N, reads: M }");
  return { writes: Number(match[1]), reads: Number(match[2]) };
}

export function releasedRecord(version, source) {
  return `${JSON.stringify({ version, ...declaredDataFormat(source) }, null, 2)}\n`;
}

export function enableLargeVaultWrites(source, previous, published) {
  const { writes, reads } = declaredDataFormat(source);
  if (writes !== 1 || reads !== 2 || previous.reads !== 2) return source;
  if (!published || published.version !== previous.version || published.reads !== 2 || published.writes !== previous.writes) return source;
  return source.replace(FORMAT_DECLARATION, "export const DATA_FORMAT = { writes: 2, reads: 2 } as const;");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  const record = new URL("server/data-format-released.json", ROOT);
  const source = readFileSync(FORMAT_SOURCE, "utf8");
  const publishedPath = process.argv[2];
  const next = publishedPath
    ? enableLargeVaultWrites(source, JSON.parse(readFileSync(record, "utf8")), JSON.parse(readFileSync(publishedPath, "utf8")))
    : source;
  if (next !== source) writeFileSync(FORMAT_SOURCE, next);
  writeFileSync(record, releasedRecord(version, next));
}
