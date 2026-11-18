// config.json: a server that cannot read it starts on defaults, without its keys and connections. Putting back a dated
// copy is the settings' own command (config-backup.ts), which keeps the file it replaces; the doctor only says so.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DoctorCheck } from "../types.ts";

export function settingsFileCheck(): DoctorCheck {
  return {
    id: "settings-file",
    title: "Settings file",
    looksAt: "config.json",
    check(ctx) {
      const file = join(ctx.dataDir, "config.json");
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "ok", summary: "Not there yet." };
        return { status: "problem", summary: "config.json cannot be read by this user.", instruction: `Give the server's user the file back (chown <user> ${file}).` };
      }
      try {
        const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { status: "ok", summary: "Reads." };
      } catch {}
      let copies = 0;
      try { copies = readdirSync(ctx.dataDir).filter((name) => /^config\.json\.bak\.\d{8}-\d{6}(?:-\d+)?$/.test(name)).length; } catch {}
      return { status: "problem", summary: "config.json cannot be understood, so the server runs on default settings, without its keys.",
        instruction: copies
          ? `Stop the server, then: openmausbot config backups, and openmausbot config restore latest (${copies} dated cop${copies === 1 ? "y" : "ies"} kept). The file it replaces is kept too.`
          : "Stop the server and put back config.json from a backup, or the data folder from the copy taken before the last update (./update.sh --rollback)." };
    },
  };
}
