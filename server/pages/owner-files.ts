// An owner-only page's files, kept in the data folder and served only behind the owner's sign-in (routes/published-pages.ts).
// Each page is written to a fresh folder and swapped in whole, so a reader never sees half an update; files and folders
// are owner-only, and only paths a page may carry are read back.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { renameWithRetry } from "../atomic.ts";
import { pageFilePath } from "../page-files.ts";
import type { PageFile } from "./bundle.ts";

const DIR_MODE = 0o700, FILE_MODE = 0o600;

export class PublishedPageFiles {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  save(pageId: string, files: readonly PageFile[]): void {
    const target = join(this.dir, pageId), staging = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    rmSync(staging, { recursive: true, force: true });
    try {
      mkdirSync(staging, { recursive: true, mode: DIR_MODE });
      for (const file of files) {
        const path = pageFilePath(file.path);
        if (path === null) throw new Error(`invalid page file: ${file.path}`);
        const full = join(staging, path);
        mkdirSync(dirname(full), { recursive: true, mode: DIR_MODE });
        writeFileSync(full, file.data, { mode: FILE_MODE });
      }
      if (!existsSync(join(staging, "index.html"))) throw new Error("the page has no index.html");
      rmSync(target, { recursive: true, force: true });
      renameWithRetry(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  /** The bytes of one file of the page, or null for a path the page cannot hold, a link, a folder, or a missing file. */
  read(pageId: string, path: string): Buffer | null {
    const file = pageFilePath(path);
    if (file === null) return null;
    const target = join(this.dir, pageId), full = resolve(target, file), inside = relative(target, full);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || inside.includes(`${sep}..`)) return null;
    try {
      return lstatSync(full).isFile() ? readFileSync(full) : null;
    } catch {
      return null;
    }
  }

  has(pageId: string): boolean {
    try {
      return lstatSync(join(this.dir, pageId, "index.html")).isFile();
    } catch {
      return false;
    }
  }

  remove(pageId: string): void {
    rmSync(join(this.dir, pageId), { recursive: true, force: true });
  }
}
