import { constants, copyFileSync, existsSync, linkSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { decodeAttachmentAttribute, escapeAttribute } from "../src/lib/composer-attachments.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { botBox } from "./bot-box/box.ts";
import { boxUploadsDir, taskWorkspaceIds } from "./bot-box/plan.ts";
import { DATA_DIR } from "./config.ts";

const TAG = /(<attached-(?:file|image)[\t ]+path=")([^"\r\n]*)(")/g;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The bot box hides the data folder, uploads included, so an `<attached-file>` path would be unreadable there.
 * Each upload the text names is linked into the conversation's uploads folder (plan.ts boxUploadsDir), which the server
 * owns and every box of the conversation sees read-only, and the path is rewritten to it. The bot can read the upload but
 * never write it or swap the folder for a link. Only the text sent to the engine changes; with the box off, or a working
 * folder that is not a conversation's own, nothing does.
 */
export function attachmentsForBox(text: string, cwd: string | undefined, boxed = botBox.enabled(), dataDir = DATA_DIR, attachmentsDir = ATTACHMENTS_DIR): string {
  if (!boxed || !cwd || !text.includes("<attached-")) return text;
  const ids = taskWorkspaceIds(resolve(cwd), resolve(dataDir));
  if (!ids) return text;
  const uploads = resolve(attachmentsDir), shown = boxUploadsDir(resolve(dataDir), ids.botId, ids.threadId);
  return text.replace(TAG, (tag, open: string, raw: string, close: string) => {
    const path = decodeAttachmentAttribute(raw), name = basename(path);
    if (resolve(dirname(path)) !== uploads || !NAME.test(name) || !existsSync(path)) return tag;
    const target = join(shown, name);
    try {
      // Uploads never change under their name, so one an earlier turn put here is kept.
      if (!existsSync(target)) {
        mkdirSync(shown, { recursive: true, mode: 0o700 });
        try {
          linkSync(path, target);
        } catch {
          // Another file system: a copy, renamed into place so one cut short never passes for a whole one.
          const partial = `${target}.${process.pid}.partial`;
          try {
            copyFileSync(path, partial, constants.COPYFILE_FICLONE);
            renameSync(partial, target);
          } finally {
            rmSync(partial, { force: true });
          }
        }
      }
    } catch {
      return tag;
    }
    return `${open}${escapeAttribute(target)}${close}`;
  });
}
