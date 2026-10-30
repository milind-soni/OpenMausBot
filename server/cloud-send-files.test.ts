import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { listBotFiles, movedFilePath, moveFilesRoute } from "./cloud-send-files.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("which bot files a move carries", () => {
  it("each bot's own folder and its conversations' folders, without memory, skills, the engines' links, installed packages or what the backup leaves out", () => {
    expect(movedFilePath("workspaces/b1/notes.md")).toBe(true);
    expect(movedFilePath("task-workspaces/b1/t1/report.csv")).toBe(true);
    for (const path of ["workspaces/b1/MEMORY.md", "workspaces/b1/memory/log/2026-10-20.md", "workspaces/b1/skills/x/SKILL.md", "workspaces/b1/.claude/skills/x",
      "task-workspaces/b1/t1/.agents/skills/x", "workspaces/b1/node_modules/a/index.js", "task-workspaces/b1/notes.md", "bots/b1/SOUL.md", "workspaces/b1/../b2/x", "workspaces/b1"]) {
      expect(movedFilePath(path), path).toBe(false);
    }
  });

  it("lists them by path, size and sha256, never through a link", async () => {
    const data = mkdtempSync(join(tmpdir(), "omb-files-"));
    mkdirSync(join(data, "workspaces", "b1", "node_modules", "x"), { recursive: true });
    mkdirSync(join(data, "task-workspaces", "b1", "t1"), { recursive: true });
    writeFileSync(join(data, "workspaces", "b1", "notes.md"), "hello");
    writeFileSync(join(data, "workspaces", "b1", "node_modules", "x", "i.js"), "no");
    writeFileSync(join(data, "task-workspaces", "b1", "t1", "r.csv"), "a,b");
    writeFileSync(join(data, "secret.txt"), "outside");
    symlinkSync(join(data, "secret.txt"), join(data, "workspaces", "b1", "link.txt"));
    expect(await listBotFiles(data, ["b1", "../x"])).toEqual([{ path: "workspaces/b1/notes.md", size: 5, sha256: sha("hello") },
      { path: "task-workspaces/b1/t1/r.csv", size: 3, sha256: sha("a,b") }]);
  });
});

describe("My Cloud takes a file", () => {
  const data = mkdtempSync(join(tmpdir(), "omb-files-"));
  const owner = { person: "p_owner", name: "Amit" };
  const deps = (who: typeof owner | null = owner) => ({ dataDir: data, bots: () => [{ id: "b1" }], owner: () => who });
  async function send(query: Record<string, string | number>, bytes: string, who: typeof owner | null = owner) {
    let answered: { status: number; body: any } | undefined;
    const url = new URL(`http://127.0.0.1/api/cloud-send/files?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])))}`);
    await moveFilesRoute(deps(who), { path: "/api/cloud-send/files", method: "POST", url, auth: {} as never, req: Readable.from([Buffer.from(bytes)]) as never,
      res: { setHeader() {} } as never, json: ((_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }) as never, readBody: (async () => null) as never });
    return answered!;
  }
  const file = (path: string, text: string, mode = "new", extra: Record<string, string> = {}) => ({ path, size: Buffer.byteLength(text), sha256: sha(text), mode, ...extra });

  it("in parts, from where its copy ends, and only whole and as sent", async () => {
    const text = "first part|second part";
    const f = file("workspaces/b1/notes.md", text);
    expect(await send({ ...f, offset: 0 }, "first part|")).toEqual({ status: 200, body: { received: 11 } });
    expect(await send({ ...f, offset: 0 }, "first part|"), "a part that does not start where its copy ends").toEqual({ status: 409, body: { received: 11 } });
    expect(await send({ ...f, offset: 11 }, "second part")).toEqual({ status: 201, body: { stored: true } });
    expect(readFileSync(join(data, "workspaces", "b1", "notes.md"), "utf8")).toBe(text);
    const wrong = file("workspaces/b1/wrong.md", "expected");
    expect((await send({ ...wrong, offset: 0 }, "otherwis")).status).toBe(422);
    expect(existsSync(join(data, "workspaces", "b1", "wrong.md"))).toBe(false);
    expect(readdirSync(join(data, "tmp", "move-files")).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("never over a file it has: a different one there is a conflict, replaced only when it is still the one the move put there", async () => {
    mkdirSync(join(data, "workspaces", "b1"), { recursive: true });
    writeFileSync(join(data, "workspaces", "b1", "plan.md"), "My Cloud's own");
    const mine = file("workspaces/b1/plan.md", "this computer's");
    expect(await send({ ...mine, offset: 0 }, "this computer's")).toEqual({ status: 409, body: { conflict: true } });
    expect(readFileSync(join(data, "workspaces", "b1", "plan.md"), "utf8")).toBe("My Cloud's own");
    expect(await send({ ...mine, mode: "replace", expect: sha("something else"), offset: 15 }, "")).toEqual({ status: 409, body: { conflict: true } });
    expect(await send({ ...mine, path: "workspaces/b1/plan (Mac).md", offset: 0 }, "this computer's"), "the part it holds already goes beside").toEqual({ status: 409, body: { received: 15 } });
    expect(await send({ ...mine, path: "workspaces/b1/plan (Mac).md", offset: 15 }, "")).toEqual({ status: 201, body: { stored: true } });
    expect(readFileSync(join(data, "workspaces", "b1", "plan (Mac).md"), "utf8")).toBe("this computer's");
    const newer = file("workspaces/b1/plan (Mac).md", "this computer's, edited", "replace", { expect: sha("this computer's") });
    expect((await send({ ...newer, offset: 0 }, "this computer's, edited")).status).toBe(201);
    expect(readFileSync(join(data, "workspaces", "b1", "plan (Mac).md"), "utf8")).toBe("this computer's, edited");
  });

  it("hands main a part of a bot file, never through a link", async () => {
    mkdirSync(join(data, "workspaces", "b1"), { recursive: true });
    writeFileSync(join(data, "workspaces", "b1", "part.md"), "0123456789");
    writeFileSync(join(data, "outside.md"), "secret");
    symlinkSync(join(data, "outside.md"), join(data, "workspaces", "b1", "linked.md"));
    const read = async (path: string, offset: number, length: number) => {
      let status = 0, bytes: Buffer = Buffer.alloc(0);
      const url = new URL(`http://127.0.0.1/api/cloud-send/files?${new URLSearchParams({ path, offset: String(offset), length: String(length) })}`);
      await moveFilesRoute(deps(), { path: "/api/cloud-send/files", method: "GET", url, auth: {} as never, req: {} as never,
        res: { setHeader() {}, writeHead: (code: number) => { status = code; }, end: (body: Buffer) => { bytes = body; } } as never,
        json: ((_res: unknown, code: number) => { status = code; }) as never, readBody: (async () => null) as never });
      return { status, text: bytes.toString() };
    };
    expect(await read("workspaces/b1/part.md", 3, 4)).toEqual({ status: 200, text: "3456" });
    expect((await read("workspaces/b1/linked.md", 0, 6)).status).toBe(404);
    expect((await read("workspaces/b1/MEMORY.md", 0, 6)).status).toBe(404);
  });

  it("only from its owner, only for a bot it has, and only a bot file a move carries", async () => {
    expect((await send({ ...file("workspaces/b1/x.md", "x"), offset: 0 }, "x", null)).status).toBe(403);
    expect((await send({ ...file("workspaces/b2/x.md", "x"), offset: 0 }, "x")).status).toBe(409);
    expect((await send({ ...file("workspaces/b1/MEMORY.md", "x"), offset: 0 }, "x")).status).toBe(400);
    expect((await send({ ...file("workspaces/b1/../../escape.md", "x"), offset: 0 }, "x")).status).toBe(400);
  });
});
