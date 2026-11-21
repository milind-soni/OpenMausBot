// Files holding keys, sign-ins or conversations are the server user's alone (0600). A file others can read (restored
// from an archive, copied by hand) is made owner-only again; its old mode is written down in the backup, and its
// contents are not copied there: a second copy of a secret is what this check is against. Not on Windows, whose files
// have no such bits.
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";

import type { DoctorCheck } from "../types.ts";

export const SECRET_FILES = [
  "config.json", "sessions.json", "bots.json", "groups.json", "messages.db", "webhooks.json", "tunnel-account.json", "browser-engine-key",
] as const;

type Loose = { name: string; path: string; mode: number };

export function secretModesCheck(platform: NodeJS.Platform = process.platform): DoctorCheck {
  return {
    id: "secret-modes",
    title: "Private files",
    looksAt: SECRET_FILES.join(", "),
    check(ctx) {
      if (platform === "win32") return { status: "ok", summary: "Not checked on Windows." };
      const loose: Loose[] = [];
      for (const name of SECRET_FILES) {
        const path = join(ctx.dataDir, name);
        try {
          const stat = lstatSync(path);
          if (stat.isFile() && (stat.mode & 0o077) !== 0) loose.push({ name, path, mode: stat.mode & 0o777 });
        } catch {}
      }
      if (!loose.length) return { status: "ok", summary: "Only the server's user can read them." };
      return { status: "problem", fixable: true, detail: loose,
        summary: `Others can read ${loose.map((file) => `${file.name} (0${file.mode.toString(8)})`).join(", ")}.` };
    },
    fix(_ctx, finding, backup) {
      const loose = finding.detail as Loose[];
      for (const file of loose) {
        backup.note("secret-modes", "made owner-only (0600); the old mode is here", file.path, file.mode);
        chmodSync(file.path, 0o600);
      }
      return `Made ${loose.map((file) => file.name).join(", ")} owner-only.`;
    },
  };
}
