import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** Writes a hook's tool result, cut at `max` characters, to a private file; true when it fit whole. */
export function spillToolResult(dir: string, key: string, text: string, max: number): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bounded = text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters omitted]` : text;
  writeFileAtomic(join(dir, `${createHash("sha256").update(key).digest("hex")}.txt`), bounded, { mode: 0o600 });
  return text.length <= max;
}
