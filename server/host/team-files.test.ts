import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compareSnapshots, createTeamFiles, teamFileName, teamFilePath, TEAM_FILES_ACTIVITY, TEAM_FILES_DIR, TeamFilesError, type TeamFiles } from "./team-files.ts";

const MIRA = { person: "p_mira", admin: false }, BEN = { person: "p_ben", admin: false }, ADA = { person: "p_ada", admin: true };
let dataDir = "", files: TeamFiles, clock = 1_000;
const body = (text: string) => Readable.from([Buffer.from(text)]);
const refused = async (work: () => unknown): Promise<{ status: number; code: string }> => {
  try { await work(); } catch (error) { if (error instanceof TeamFilesError) return { status: error.status, code: error.code }; throw error; }
  throw new Error("not refused");
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-team-files-"));
  clock = 1_000;
  files = createTeamFiles({ dataDir, now: () => clock, cap: 64, uploadMax: 32 });
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("paths", () => {
  it("takes relative paths and names, and refuses every way out of the folder", () => {
    expect(teamFilePath("")).toBe("");
    expect(teamFilePath("/payroll//nov.csv/")).toBe("payroll/nov.csv");
    expect(teamFilePath("Clients/Acme Ltd/brief.md")).toBe("Clients/Acme Ltd/brief.md");
    for (const bad of ["..", "a/../b", "./a", "a\\b", "a\u0000b", "a\nb", " ", "x".repeat(256), 3, null, `a/${"b/".repeat(600)}`]) {
      expect(teamFilePath(bad), String(bad)).toBeNull();
    }
    expect(teamFileName("nov.csv")).toBe("nov.csv");
    expect(teamFileName("a/b")).toBeNull();
    expect(teamFileName("")).toBeNull();
  });

  it("never follows a link a bot left in the folder", async () => {
    const outside = join(dataDir, "config.json");
    writeFileSync(outside, "secret");
    mkdirSync(join(dataDir, TEAM_FILES_DIR), { recursive: true });
    symlinkSync(outside, join(dataDir, TEAM_FILES_DIR, "config.json"));
    symlinkSync(dataDir, join(dataDir, TEAM_FILES_DIR, "data"));
    expect(await refused(() => files.open("config.json"))).toEqual({ status: 400, code: "link" });
    expect(await refused(() => files.list("data", ADA))).toEqual({ status: 400, code: "link" });
    expect(await refused(() => files.upload("data", "x.txt", body("x"), 1, ADA))).toEqual({ status: 400, code: "link" });
    expect(files.list("", ADA).entries.map((entry) => entry.name)).toEqual([]);
  });
});

describe("the folder", () => {
  it("uploads, lists with who uploaded, opens, renames and deletes", async () => {
    files.folder("payroll", MIRA);
    clock = 2_000;
    const entry = await files.upload("payroll", "nov.csv", body("a,b\n1,2\n"), 8, MIRA);
    expect(entry).toMatchObject({ path: "payroll/nov.csv", kind: "file", size: 8, owner: "p_mira", last: { action: "uploaded", person: "p_mira", at: 2_000 } });
    expect(files.list("", BEN).entries).toMatchObject([{ name: "payroll", kind: "folder", owner: "p_mira", last: { path: "payroll/nov.csv", action: "uploaded" } }]);
    const opened = files.open("payroll/nov.csv");
    expect(opened.size).toBe(8);
    expect(await new Promise<string>((resolve) => { let text = ""; files.stream(opened.fd).on("data", (chunk) => { text += chunk; }).on("end", () => resolve(text)); })).toBe("a,b\n1,2\n");
    files.rename("payroll/nov.csv", "payroll/november.csv", MIRA);
    expect(files.list("payroll", MIRA).entries).toMatchObject([{ name: "november.csv", owner: "p_mira", last: { action: "renamed", from: "payroll/nov.csv" } }]);
    files.remove("payroll/november.csv", MIRA);
    expect(files.list("payroll", MIRA).entries).toEqual([]);
    expect(JSON.parse(readFileSync(join(dataDir, TEAM_FILES_ACTIVITY), "utf8")).changes.map((change: { action: string }) => change.action))
      .toEqual(["folder", "uploaded", "renamed", "deleted"]);
  });

  it("lets a member delete, rename and replace only what they uploaded; an admin anything", async () => {
    await files.upload("", "brief.md", body("hi"), 2, MIRA);
    expect(await refused(() => files.remove("brief.md", BEN))).toEqual({ status: 403, code: "forbidden" });
    expect(await refused(() => files.rename("brief.md", "x.md", BEN))).toEqual({ status: 403, code: "forbidden" });
    expect(await refused(() => files.upload("", "brief.md", body("no"), 2, BEN))).toEqual({ status: 409, code: "exists" });
    await files.upload("", "brief.md", body("v2"), 2, MIRA);
    files.folder("shared", MIRA);
    await files.upload("shared", "ben.txt", body("b"), 1, BEN);
    expect(await refused(() => files.remove("shared", MIRA)), "her folder holds Ben's file").toEqual({ status: 403, code: "forbidden" });
    files.remove("shared", ADA);
    files.remove("brief.md", ADA);
    expect(files.list("", ADA).entries).toEqual([]);
  });

  it("refuses an upload over the per-file limit or past the cap, and keeps nothing of it", async () => {
    expect(await refused(() => files.upload("", "big.bin", body("x".repeat(40)), 40, MIRA))).toEqual({ status: 413, code: "too_large" });
    expect(await refused(() => files.upload("", "big.bin", body("x".repeat(40)), null, MIRA)), "a body longer than it said").toEqual({ status: 413, code: "too_large" });
    await files.upload("", "a.bin", body("x".repeat(30)), 30, MIRA);
    await files.upload("", "b.bin", body("x".repeat(30)), 30, MIRA);
    files.reload();
    expect(await refused(() => files.upload("", "c.bin", body("x".repeat(10)), 10, MIRA))).toEqual({ status: 507, code: "full" });
    expect(files.full()).toBe(false);
    expect(files.list("", MIRA).entries.map((entry) => entry.name)).toEqual(["a.bin", "b.bin"]);
    expect(files.used()).toBe(60);
  });

  it("refuses names that are taken, and a folder into itself", async () => {
    files.folder("a", ADA);
    expect(await refused(() => files.folder("a", ADA))).toEqual({ status: 409, code: "exists" });
    expect(await refused(() => files.rename("a", "a/b", ADA))).toEqual({ status: 400, code: "bad_path" });
    expect(await refused(() => files.upload("missing", "x.txt", body("x"), 1, ADA))).toEqual({ status: 404, code: "not_found" });
    expect(await refused(() => files.open("a"))).toEqual({ status: 400, code: "not_file" });
  });
});

describe("the team's template library", () => {
  it("is the admins' to change; members see it; it counts toward the space used", async () => {
    files.ensure();
    mkdirSync(join(dataDir, TEAM_FILES_DIR, "templates", "reporter"), { recursive: true });
    writeFileSync(join(dataDir, TEAM_FILES_DIR, "templates", "reporter", "bot.yaml"), "name: Reporter\n");
    expect(files.list("templates", MIRA).entries.map((entry) => entry.name)).toEqual(["reporter"]);
    expect(files.mayRemove("templates/reporter", MIRA)).toBe(false);
    expect(files.mayRemove("templates/reporter", ADA)).toBe(true);
    expect(await refused(() => files.upload("templates", "x.yaml", body("x"), 1, MIRA))).toEqual({ status: 403, code: "forbidden" });
    expect(await refused(() => files.folder("templates/mine", MIRA))).toEqual({ status: 403, code: "forbidden" });
    expect(await refused(() => files.remove("templates/reporter", MIRA))).toEqual({ status: 403, code: "forbidden" });
    await files.upload("", "a.md", body("a"), 1, MIRA);
    expect(await refused(() => files.rename("a.md", "templates/a.md", MIRA))).toEqual({ status: 403, code: "forbidden" });
    files.reload();
    expect(files.used()).toBe(1 + "name: Reporter\n".length);
    expect([...files.snapshot()!.keys()], "never a turn's change").toEqual(["a.md"]);
    files.remove("templates/reporter", ADA);
  });
});

describe("a turn's changes", () => {
  const root = () => join(dataDir, TEAM_FILES_DIR);

  it("records what a bot added, changed and deleted, as the bot's for the person it worked for", async () => {
    await files.upload("", "old.csv", body("1"), 1, MIRA);
    writeFileSync(join(root(), "edit.md"), "v1");
    expect(files.beginTurn("t-mira", { bot: "payroll", person: "p_mira" })).toBe(true);
    clock = 5_000;
    writeFileSync(join(root(), "new.csv"), "x");
    writeFileSync(join(root(), "edit.md"), "v2 longer");
    rmSync(join(root(), "old.csv"));
    expect(files.endTurn("t-mira")).toEqual({ added: ["new.csv"], changed: ["edit.md"], deleted: ["old.csv"] });
    expect(files.activity().slice(-3)).toEqual([
      { at: 5_000, path: "new.csv", action: "added", bot: "payroll", person: "p_mira" },
      { at: 5_000, path: "edit.md", action: "changed", bot: "payroll", person: "p_mira" },
      { at: 5_000, path: "old.csv", action: "deleted", bot: "payroll", person: "p_mira" },
    ]);
    expect(files.list("", BEN).entries.find((entry) => entry.name === "new.csv")?.last).toMatchObject({ bot: "payroll", person: "p_mira" });
    expect(files.endTurn("t-mira"), "once").toBeNull();
  });

  it("never claims what the page or another turn changed meanwhile", async () => {
    files.beginTurn("t-mira", { bot: "payroll", person: "p_mira" });
    files.beginTurn("t-ben", { bot: "notes", person: "p_ben" });
    await files.upload("", "uploaded.pdf", body("pdf"), 3, ADA);
    writeFileSync(join(root(), "ben.md"), "b");
    expect(files.endTurn("t-ben")).toEqual({ added: ["ben.md"], changed: [], deleted: [] });
    writeFileSync(join(root(), "mira.md"), "m");
    expect(files.endTurn("t-mira")).toEqual({ added: ["mira.md"], changed: [], deleted: [] });
    expect(files.list("", ADA).entries.find((entry) => entry.name === "uploaded.pdf")?.last).toMatchObject({ action: "uploaded", person: "p_ada" });
  });

  it("compares by size and modification time only", () => {
    files.ensure();
    writeFileSync(join(root(), "a.txt"), "aa");
    const before = files.snapshot()!;
    utimesSync(join(root(), "a.txt"), new Date(5_000_000), new Date(5_000_000));
    expect(compareSnapshots(before, files.snapshot()!)).toEqual({ added: [], changed: ["a.txt"], deleted: [] });
    expect(compareSnapshots(new Map([["x", "1:1"]]), new Map())).toEqual({ added: [], changed: [], deleted: ["x"] });
  });
});
