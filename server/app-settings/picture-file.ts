// A picture a bot names by path, for a bot's picture or the person's own: copied into the attachment store, so it is
// served and kept like a picture the person picks in Settings.
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar.ts";
import { sniffRaster } from "../generated-image.ts";
import { openMessageFile } from "../message-file.ts";
import type { Turn } from "./host.ts";

export const PICTURE_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const PICTURE_FILE_KINDS = "a PNG, JPEG, GIF or WebP picture";

export interface PictureFileDeps {
  attachmentsDir: string;
  /** The bot's own folders this turn: its working folder and workspace. */
  ownFolders(turn: Turn): readonly string[];
  /** Whether this turn's conversation carries the stored attachment of this name. */
  inConversation(turn: Turn, name: string): boolean;
  /** Stores the bytes as an attachment and returns its path. */
  save(bytes: Buffer, mime: string): string;
  remove(path: string): void;
}

export type TakenPicture = { avatarUrl: string } | { refusal: string };

const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};
const outside = (path: string) => `${path} is outside your workspace, your working folder and this conversation's files, so it can't be a picture.`;

function refusalFor(error: unknown, path: string): string {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (status === 404) return `No file was found at ${path}. Save the picture in your workspace or working folder and pass its exact path.`;
  if (code === "outside_workspace") return outside(path);
  if (status === 413) return `That file is over ${PICTURE_FILE_MAX_BYTES / 1024 / 1024} MB. Use a smaller picture.`;
  return error instanceof Error ? error.message : "That file could not be read.";
}

export function createPictureFiles(deps: PictureFileDeps) {
  return {
    /** Security: the file opens through the message-file resolver (its real path inside the bot's folders, no link at the
     * end, the size cap), a stored attachment only when this conversation carries it, and its bytes, never its name,
     * must be a PNG, JPEG, GIF or WebP. */
    async take(turn: Turn, path: string): Promise<TakenPicture> {
      let opened;
      try {
        opened = await openMessageFile(path, [...deps.ownFolders(turn), deps.attachmentsDir], PICTURE_FILE_MAX_BYTES);
      } catch (error) {
        return { refusal: refusalFor(error, path) };
      }
      try {
        const store = await realpath(deps.attachmentsDir).catch(() => null);
        if (store && inside(store, opened.path) && !deps.inConversation(turn, basename(opened.path))) return { refusal: outside(path) };
        const bytes = await opened.handle.readFile();
        const mime = sniffRaster(bytes);
        if (!mime) return { refusal: `${basename(opened.path)} is not ${PICTURE_FILE_KINDS}.` };
        const saved = deps.save(bytes, mime);
        const avatarUrl = botAvatarUrlFromStoredPath(saved);
        if (avatarUrl) return { avatarUrl };
        deps.remove(saved);
        return { refusal: "That picture could not be stored." };
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    },
    /** Takes back a picture `take` stored for a change that did not happen. */
    discard(avatarUrl: string) {
      deps.remove(join(deps.attachmentsDir, basename(avatarUrl)));
    },
  };
}
