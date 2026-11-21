// Copies of a file whose content could not be understood, kept beside it so the bytes are not lost.
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Copies of unreadable content kept beside the file; a further one is not copied. */
const ASIDE_COPIES = 5;

/** Copies the unreadable file beside itself, named by its content so the same content is copied once. Returns the copy's
 * path, or null when there is nothing to copy or the copy cannot be made. The file itself stays where it is. */
export function keepUnreadableAside(file: string): string | null {
  try {
    const aside = `${file}.unreadable-${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12)}`;
    if (existsSync(aside)) return aside;
    if (readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.unreadable-`)).length >= ASIDE_COPIES) return null;
    copyFileSync(file, aside, constants.COPYFILE_EXCL);
    chmodSync(aside, 0o600);
    return aside;
  } catch {
    return null;
  }
}
