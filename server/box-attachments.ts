import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { escapeAttribute } from "../src/lib/composer-attachments.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { botBox } from "./bot-box/box.ts";

/** The folder in a boxed turn's working folder that holds its copies of the person's uploads. */
export const BOX_ATTACHMENTS_FOLDER = ".attachments";

const TAG = /(<attached-(?:file|image)[\t ]+path=")([^"\r\n]*)(")/g;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The bot box hides the data folder, uploads included, so an `<attached-file>` path would be unreadable there.
 * Each upload the text names is copied into the turn's working folder (which the box always binds) and the path
 * is rewritten to the copy. Only the text sent to the engine changes; with the box off, or no working folder, nothing does.
 */
export function attachmentsForBox(text: string, cwd: string | undefined, boxed = botBox.enabled(), attachmentsDir = ATTACHMENTS_DIR): string {
  if (!boxed || !cwd || !text.includes("<attached-")) return text;
  const uploads = resolve(attachmentsDir);
  return text.replace(TAG, (tag, open: string, path: string, close: string) => {
    const name = basename(path);
    if (resolve(dirname(path)) !== uploads || !NAME.test(name)) return tag;
    const staged = join(cwd, BOX_ATTACHMENTS_FOLDER, name);
    try {
      // Uploads never change under their name, so a copy made by an earlier turn (and maybe edited since) is kept.
      if (!existsSync(staged)) {
        mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
        // A copy, never a link: an engine editing its copy must not change the person's upload. Renamed into place, so a
        // copy cut short never passes for a whole one.
        const partial = `${staged}.${process.pid}.partial`;
        try {
          copyFileSync(path, partial, constants.COPYFILE_FICLONE);
          renameSync(partial, staged);
        } finally {
          rmSync(partial, { force: true });
        }
      }
    } catch {
      return tag;
    }
    return `${open}${escapeAttribute(staged)}${close}`;
  });
}
