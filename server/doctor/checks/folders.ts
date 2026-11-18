// The folders a server writes into from its first moment (config.ts ensureDirs). A missing one is made; a file where a
// folder should be, or a data folder this user cannot write, is for a person.
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DoctorCheck } from "../types.ts";

export const SERVER_FOLDERS = ["events", "native"] as const;

export function foldersCheck(): DoctorCheck {
  return {
    id: "folders",
    title: "Folders",
    looksAt: `the data folder, ${SERVER_FOLDERS.join(", ")}`,
    check(ctx) {
      let data;
      try { data = statSync(ctx.dataDir); } catch {
        return { status: "problem", summary: `There is no data folder at ${ctx.dataDir}.`,
          instruction: "Check the path (--data-dir, or OMB_DATA_DIR). A server starting there makes a new, empty one." };
      }
      if (!data.isDirectory()) return { status: "problem", summary: `${ctx.dataDir} is a file, not a folder.`, instruction: "Move that file away, or point the server at its data folder." };
      try { accessSync(ctx.dataDir, constants.W_OK); } catch {
        return { status: "problem", summary: "This user cannot write to the data folder.",
          instruction: `Give the user the server runs as the folder back (for example: chown -R <user> ${ctx.dataDir}).` };
      }
      const notFolders = SERVER_FOLDERS.filter((name) => existsSync(join(ctx.dataDir, name)) && !statSync(join(ctx.dataDir, name)).isDirectory());
      if (notFolders.length) {
        return { status: "problem", summary: `${notFolders.join(", ")} should be a folder, and is a file.`,
          instruction: `Move ${notFolders.map((name) => join(ctx.dataDir, name)).join(", ")} out of the data folder, then start the server.` };
      }
      const missing = SERVER_FOLDERS.filter((name) => !existsSync(join(ctx.dataDir, name)));
      if (missing.length) return { status: "problem", fixable: true, summary: `Missing folder${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`, detail: missing };
      return { status: "ok", summary: "All there." };
    },
    fix(ctx, finding, backup) {
      const missing = finding.detail as string[];
      for (const name of missing) {
        mkdirSync(join(ctx.dataDir, name), { recursive: true });
        backup.note("folders", "folder made", join(ctx.dataDir, name));
      }
      return `Made ${missing.join(", ")}.`;
    },
  };
}
