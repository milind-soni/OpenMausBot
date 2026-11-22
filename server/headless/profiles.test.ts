import "../testing/scrub-ambient-omb-env.ts";

import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { parseCommand } from "./args.ts";
import { runHeadless } from "./main.ts";
import type { HeadlessIo } from "./output.ts";

const ACME = join(import.meta.dirname, "..", "testing", "fixtures", "profiles", "acme");
const scratch = mkdtempSync(join(tmpdir(), "omb-profiles-cli-"));
afterAll(() => removeTempDir(scratch));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
  return { io, out, err };
}

const noServer = { env: {}, request: vi.fn(async () => { throw new Error("profiles check must not reach a server"); }), callTool: vi.fn(async () => { throw new Error("no tools"); }) };

describe("edubot profiles check", () => {
  it("parses as its own verb with one folder", () => {
    expect(parseCommand(["profiles", "check", "dir"])).toEqual({ verb: "profiles check", flags: {}, positionals: ["dir"] });
  });

  it("exits 0 for a good folder and prints each bot as its organization and area make it", async () => {
    const { io, out, err } = capture();
    expect(await runHeadless(["profiles", "check", ACME], { ...noServer, io })).toBe(0);
    expect(out).toEqual([
      "OK: Acme · 2 areas · 3 bots · 1 skill · 1 MCP server",
      "  bi/analyst  Analista BI · Chief · claude/claude-sonnet-5-5 · Auto · Edu brain area · Edu crew · MCP notion · skills weekly-report",
      "  bi/reporter  Reporter · claude/claude-sonnet-5-5 · Ask · Edu brain area · MCP notion · skills weekly-report",
      "  sales/closer  Closer · codex/gpt-5.5 · Accept edits · Edu brain cloud · MCP notion",
    ]);
    expect(err).toEqual([]);
    expect(noServer.request).not.toHaveBeenCalled();
    expect(noServer.callTool).not.toHaveBeenCalled();
  });

  it("exits 1 with one sentence per problem, and prints warnings without failing", async () => {
    const dir = join(scratch, "broken");
    cpSync(ACME, dir, { recursive: true });
    writeFileSync(join(dir, "areas", "sales", "bots", "closer.md"), "---\nedubot: 1\nkind: bot\nkey: closer\nname: Closer\napproval: always\ncomputer: local\n---\n");
    writeFileSync(join(dir, "areas", "bi", "notes.md"), "x");
    const { io, out } = capture();
    expect(await runHeadless(["profiles", "check", dir], { ...noServer, io })).toBe(1);
    expect(out).toEqual([
      "areas/sales/bots/closer.md, line 6: approval must be ask, edits, auto or full",
      "areas/sales/bots/closer.md, line 7: computer is chosen by each person in the app (where a bot works depends on the computer), so it never goes in a profile",
      "warning: areas/bi/notes.md: is not a profile file, so it is ignored",
      "2 problems found. Nothing was applied: this check only reads the folder.",
    ]);
  });

  it("prints one JSON document with --json: problems, warnings and the resolved bots", async () => {
    const { io, out } = capture();
    expect(await runHeadless(["profiles", "check", ACME, "--json"], { ...noServer, io })).toBe(0);
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0]!);
    expect(result).toMatchObject({ ok: true, problems: [], warnings: [], organization: { name: "Acme" } });
    expect(result.bots.map((bot: { id: string }) => bot.id)).toEqual(["bi/analyst", "bi/reporter", "sales/closer"]);
    expect(result.skills).toEqual([{ file: "areas/bi/skills/weekly-report/SKILL.md", area: "bi", name: "weekly-report", description: "Write the weekly sales report from the week's numbers." }]);
  });

  it("exits 2 when the folder is missing or not named", async () => {
    const missing = capture();
    expect(await runHeadless(["profiles", "check", join(scratch, "nowhere")], { ...noServer, io: missing.io })).toBe(2);
    expect(missing.err).toEqual([`error: ${join(scratch, "nowhere")} does not exist`]);
    const unnamed = capture();
    expect(await runHeadless(["profiles", "check"], { ...noServer, io: unnamed.io })).toBe(2);
    expect(unnamed.err).toEqual(["error: name the profile folder", "hint: edubot profiles check FOLDER"]);
  });
});
