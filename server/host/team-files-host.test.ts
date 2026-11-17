import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTeamFilesHost } from "./team-files-host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function host(options: { team?: boolean; boxOn?: boolean; edit?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-team-files-host-"));
  dirs.push(dataDir);
  const bots = [{ id: "payroll", teamFilesEdit: options.edit ?? false }, { id: "notes" }];
  return { dataDir, host: createTeamFilesHost({ team: options.team === false ? null : { name: "Acme" }, dataDir, bots: () => bots, boxOn: () => options.boxOn ?? true, askerOf: (threadId) => (threadId === "t-mira" ? "p_mira" : null) }) };
}

describe("Team files on a Team Cloud at run time", () => {
  it("is nothing off a Team Cloud: no folder, no box mount, no line", () => {
    const { host: off } = host({ team: false });
    expect(off.files).toBeNull();
    expect(off.boxFolder("payroll")).toBeNull();
    expect(off.promptLine("payroll")).toBe("");
  });

  it("mounts the folder read-write only for a bot an admin let edit it, and tells each bot which", () => {
    const { host: on, dataDir } = host({ edit: true });
    expect(on.boxFolder("payroll")).toEqual({ source: join(dataDir, "team-files"), write: true });
    expect(on.boxFolder("notes")).toEqual({ source: join(dataDir, "team-files"), write: false });
    expect(on.boxFolder(null)?.write).toBe(false);
    expect(on.promptLine("payroll")).toBe("\n\nTeam files, the folder everyone at Acme shares: /team-files. You can add and change files there; everyone on the team sees them.");
    expect(on.promptLine("notes")).toBe("\n\nTeam files, the folder everyone at Acme shares: /team-files. It is read-only for you.");
    // Without a box the folder is where the server keeps it.
    const { host: unboxed, dataDir: where } = host({ boxOn: false });
    expect(unboxed.promptLine("notes")).toContain(`shares: ${join(where, "team-files")}. It is read-only for you.`);
  });

  it("records a turn's changes for a bot that may edit, and for any bot where no box keeps the folder read-only", () => {
    const { host: on, dataDir } = host({ edit: true });
    on.beginTurn("payroll", "t-mira");
    writeFileSync(join(dataDir, "team-files", "nov.csv"), "x");
    on.onEvent({ type: "turn.completed", threadId: "t-mira" });
    expect(on.files!.activity()).toMatchObject([{ path: "nov.csv", action: "added", bot: "payroll", person: "p_mira" }]);
    on.beginTurn("notes", "t-other");
    expect(on.files!.openTurns(), "a read-only bot in a box changes nothing").toBe(0);
    const { host: unboxed, dataDir: plain } = host({ boxOn: false });
    unboxed.beginTurn("notes", "t-other");
    writeFileSync(join(plain, "team-files", "x.md"), "y");
    unboxed.onEvent({ type: "session.exited", threadId: "t-other" });
    expect(unboxed.files!.activity()).toMatchObject([{ path: "x.md", action: "added", bot: "notes" }]);
  });
});
