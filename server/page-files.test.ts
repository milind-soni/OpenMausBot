import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";

import { AppDocs } from "./app-docs.ts";
import { createPageFiles, pageFilePath, PAGE_FILES_PREFIX } from "./page-files.ts";
import type { PageVideo } from "./pages/bundle.ts";

const opened = vi.hoisted(() => [] as import("node:fs/promises").FileHandle[]);
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, open: async (...args: Parameters<typeof real.open>) => { const handle = await real.open(...args); opened.push(handle); return handle; } };
});

const PARQUET = Buffer.from("PAR1\u0000\u0001\u0002\u0003 rows and columns PAR1", "latin1");

function setup() {
  const docs = new AppDocs(join(mkdtempSync(join(tmpdir(), "omb-page-files-")), "app-docs"));
  const stored = docs.put({ source: "html", html: "<h1>Sales</h1><script src=\"app.js\"></script>", data: { folder: "/work/dash" },
    files: [{ path: "app.js", data: Buffer.from("draw()") }, { path: "data/sales.parquet", data: PARQUET }, { path: "notes.html", data: Buffer.from("<p>n</p>") }] });
  if (!stored.ok) throw new Error("not stored");
  let clock = 1_000;
  const files = createPageFiles({ docs, now: () => clock });
  const folder = files.folder({ threadId: "t1", messageId: "m1", doc: stored.doc });
  const get = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const out: { status: number; headers: Record<string, string>; body: Buffer; handled: boolean } = { status: 0, headers: {}, body: Buffer.alloc(0), handled: false };
    const res = {
      writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; return res; },
      end(body?: Buffer | string) { if (body) out.body = Buffer.isBuffer(body) ? body : Buffer.from(body); },
    };
    out.handled = files.serve({ headers: init.headers ?? {} } as never, res as never, path, init.method ?? "GET");
    return out;
  };
  return { docs, files, folder, get, stored, tick: (ms: number) => { clock += ms; } };
}

describe("a folder page's files route", () => {
  it("gives one document one unguessable folder, the same while it is in use", () => {
    const { files, folder, stored } = setup();
    expect(folder).toMatch(new RegExp(`^${PAGE_FILES_PREFIX}[A-Za-z0-9_-]{43}/$`));
    expect(files.folder({ threadId: "t1", messageId: "m1", doc: stored.doc })).toBe(folder);
    expect(files.folder({ threadId: "t1", messageId: "m2", doc: stored.doc })).not.toBe(folder);
  });

  it("gives each viewer a token of their own, which stops answering the moment they may no longer see the page", () => {
    const { files, folder, get, stored } = setup();
    let seesIt = true;
    const ann = files.folder({ threadId: "t1", messageId: "m1", doc: stored.doc }, { key: "session:ann", allowed: () => seesIt });
    const bob = files.folder({ threadId: "t1", messageId: "m1", doc: stored.doc }, { key: "session:bob", allowed: () => true });
    expect(new Set([folder, ann, bob]).size).toBe(3);
    expect(files.folder({ threadId: "t1", messageId: "m1", doc: stored.doc }, { key: "session:ann", allowed: () => seesIt })).toBe(ann);
    expect(get(`${ann}app.js`).status).toBe(200);
    seesIt = false;
    expect(get(`${ann}app.js`)).toMatchObject({ status: 404, body: Buffer.from("Not found.") });
    expect(get(ann).status).toBe(404);
    expect(get(`${bob}app.js`).status).toBe(200);
  });

  it("serves the stored files read-only, sandboxed if opened directly, and readable from the frame's opaque origin", () => {
    const { folder, get } = setup();
    const script = get(`${folder}app.js`);
    expect(script).toMatchObject({ handled: true, status: 200 });
    expect(script.body.toString()).toBe("draw()");
    expect(script.headers).toMatchObject({
      "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox allow-scripts; default-src 'none'", "cross-origin-resource-policy": "cross-origin", "cache-control": "private, no-store",
    });
    expect(get(`${folder}notes.html`).headers["content-security-policy"]).toBe("sandbox allow-scripts; default-src 'none'");
    expect(get(folder).body.toString()).toBe("<h1>Sales</h1><script src=\"app.js\"></script>");
    expect(get(`${folder}app.js`, { method: "HEAD" })).toMatchObject({ status: 200, body: Buffer.alloc(0) });
    expect(get(`${folder}app.js`, { method: "POST" }).status).toBe(405);
    expect(get(`${folder}app.js`, { method: "OPTIONS" })).toMatchObject({ status: 204, headers: { "access-control-allow-headers": "Range" } });
  });

  it("answers a byte range, as DuckDB reads a Parquet file", () => {
    const { folder, get } = setup();
    const whole = get(`${folder}data/sales.parquet`);
    expect(whole.headers).toMatchObject({ "content-type": "application/vnd.apache.parquet", "accept-ranges": "bytes", "content-length": String(PARQUET.byteLength) });
    expect(whole.body.equals(PARQUET)).toBe(true);
    const tail = get(`${folder}data/sales.parquet`, { headers: { range: "bytes=-4" } });
    expect(tail).toMatchObject({ status: 206, headers: { "content-range": `bytes ${PARQUET.byteLength - 4}-${PARQUET.byteLength - 1}/${PARQUET.byteLength}` } });
    expect(tail.body.toString("latin1")).toBe("PAR1");
    expect(get(`${folder}data/sales.parquet`, { headers: { range: "bytes=0-3" } }).body.toString("latin1")).toBe("PAR1");
    expect(get(`${folder}data/sales.parquet`, { headers: { range: "bytes=999-" } }).status).toBe(416);
    expect(get(`${folder}data/sales.parquet`, { headers: { range: "lines=1-2" } }).status).toBe(416);
  });

  it("refuses a path that steps out of the folder or isn't one of its files, and a token it didn't give or that went stale", () => {
    const { folder, get, tick } = setup();
    for (const path of ["../app.js", "data/../app.js", "%2e%2e/app.js", "data%2Fsales.parquet", "data//sales.parquet", "data\\sales.parquet", "./app.js", "app.js%00"]) {
      expect(get(`${folder}${path}`).status, path).toBe(400);
    }
    expect(get(`${folder}secret.txt`).status).toBe(404);
    expect(get(`${folder}DATA/sales.parquet`).status).toBe(404);
    expect(get(`${PAGE_FILES_PREFIX}${"x".repeat(43)}/app.js`).status).toBe(404);
    expect(get(`${PAGE_FILES_PREFIX}short/app.js`).status).toBe(404);
    expect(get(folder.slice(0, -1)).status).toBe(404);
    expect(get("/api/bots").handled).toBe(false);
    tick(24 * 60 * 60_000 + 1);
    expect(get(`${folder}app.js`).status).toBe(404);
  });

  it("reads paths the way the folder stored them", () => {
    expect([pageFilePath(""), pageFilePath("a/b.js"), pageFilePath("my%20data.csv"), pageFilePath(".."), pageFilePath("a/./b"), pageFilePath("%E0%A4%A")])
      .toEqual(["index.html", "a/b.js", "my data.csv", null, null, null]);
  });
});

describe("a folder page's video", () => {
  const MOVIE = Buffer.alloc(3 * 1024 * 1024, "movie");

  function recorded(path: string): PageVideo {
    const info = statSync(path, { bigint: true });
    return { file: path, bytes: Number(info.size), dev: String(info.dev), ino: String(info.ino), mtimeNs: String(info.mtimeNs) };
  }
  function setupVideo(videos: (dir: string) => Record<string, PageVideo> = (dir) => ({ "clip.mp4": recorded(join(dir, "clip.mp4")) })) {
    const dir = mkdtempSync(join(tmpdir(), "omb-page-video-"));
    writeFileSync(join(dir, "clip.mp4"), MOVIE);
    const docs = new AppDocs(join(dir, "app-docs"));
    const stored = docs.put({ source: "html", html: "<video src=\"clip.mp4\">", data: { folder: dir, videos: videos(dir) } });
    if (!stored.ok) throw new Error("not stored");
    const files = createPageFiles({ docs });
    const folder = files.folder({ threadId: "t1", messageId: "m1", doc: stored.doc });
    const get = async (path: string, init: { method?: string; range?: string } = {}) => {
      const out = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) };
      const chunks: Buffer[] = [];
      const res = Object.assign(new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } }), {
        writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; return res; },
      });
      expect(files.serve({ headers: init.range ? { range: init.range } : {} } as never, res as never, `${folder}${path}`, init.method ?? "GET")).toBe(true);
      await finished(res);
      out.body = Buffer.concat(chunks);
      return out;
    };
    return { dir, docs, doc: stored.doc, get, files, folder };
  }

  it("streams the asked-for bytes, with the type from its own table and the same headers as any page file", async () => {
    const { get, dir } = setupVideo((at) => {
      writeFileSync(join(at, "page.webm"), "<script>alert(1)</script>");
      writeFileSync(join(at, "film.mov"), "moov");
      return { "clip.mp4": recorded(join(at, "clip.mp4")), "page.webm": recorded(join(at, "page.webm")), "film.mov": recorded(join(at, "film.mov")) };
    });
    const part = await get("clip.mp4", { range: "bytes=1000000-1000009" });
    expect(part).toMatchObject({ status: 206, headers: {
      "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": "10", "content-range": `bytes 1000000-1000009/${MOVIE.byteLength}`, "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "sandbox allow-scripts; default-src 'none'" } });
    expect(part.body.equals(MOVIE.subarray(1_000_000, 1_000_010))).toBe(true);
    expect((await get("clip.mp4", { range: "bytes=-4" })).body.equals(MOVIE.subarray(-4))).toBe(true);
    expect((await get("clip.mp4", { range: "bytes=3145720-" })).headers["content-length"]).toBe("8");
    expect(await get("clip.mp4", { range: `bytes=${MOVIE.byteLength}-` })).toMatchObject({ status: 416, headers: { "content-range": `bytes */${MOVIE.byteLength}` } });
    expect((await get("clip.mp4", { range: "lines=1-2" })).status).toBe(416);
    const whole = await get("clip.mp4");
    expect(whole).toMatchObject({ status: 200, headers: { "content-length": String(MOVIE.byteLength) } });
    expect(whole.body.equals(MOVIE)).toBe(true);
    expect(await get("clip.mp4", { method: "HEAD", range: "bytes=0-1" })).toMatchObject({ status: 206, body: Buffer.alloc(0) });
    expect((await get("page.webm")).headers["content-type"]).toBe("video/webm");
    expect((await get("film.mov")).headers["content-type"]).toBe("video/quicktime");
    expect(dir).toBeTruthy();
  });

  it("serves no path the document did not record, whatever is beside it on disk", async () => {
    const { get, dir, docs, doc } = setupVideo();
    writeFileSync(join(dir, "other.mp4"), MOVIE);
    expect(docs.video(doc, "__proto__")).toBeNull();
    expect(docs.video(doc, "constructor")).toBeNull();
    expect((await get("other.mp4")).status).toBe(404);
    expect((await get("__proto__")).status).toBe(404);
    expect((await get("constructor")).status).toBe(404);
    expect((await get("CLIP.MP4")).status).toBe(404);
    expect((await get("../clip.mp4")).status).toBe(400);
  });

  it("refuses a file deleted, replaced or edited since the page was shown", async () => {
    const deleted = setupVideo();
    rmSync(join(deleted.dir, "clip.mp4"));
    expect((await deleted.get("clip.mp4")).status).toBe(404);

    const FIXED = new Date(1_700_000_000_000);
    const pinned = (at: string) => { utimesSync(join(at, "clip.mp4"), FIXED, FIXED); return { "clip.mp4": recorded(join(at, "clip.mp4")) }; };
    const replaced = setupVideo(pinned);
    expect((await replaced.get("clip.mp4", { range: "bytes=0-9" })).status).toBe(206);
    writeFileSync(join(replaced.dir, "new.mp4"), MOVIE);
    utimesSync(join(replaced.dir, "new.mp4"), FIXED, FIXED);
    renameSync(join(replaced.dir, "new.mp4"), join(replaced.dir, "clip.mp4"));
    expect((await replaced.get("clip.mp4", { range: "bytes=0-9" })).status).toBe(404);

    const resized = setupVideo(pinned);
    writeFileSync(join(resized.dir, "clip.mp4"), Buffer.alloc(MOVIE.byteLength + 1));
    utimesSync(join(resized.dir, "clip.mp4"), FIXED, FIXED);
    expect((await resized.get("clip.mp4")).status).toBe(404);

    const edited = setupVideo();
    writeFileSync(join(edited.dir, "clip.mp4"), Buffer.alloc(MOVIE.byteLength, "other"));
    utimesSync(join(edited.dir, "clip.mp4"), new Date(), new Date(Date.now() + 60_000));
    expect((await edited.get("clip.mp4")).status).toBe(404);
  });

  it.skipIf(process.platform === "win32")("refuses a symlink swapped in after showing, even to the very same file", async () => {
    const { get, dir } = setupVideo();
    renameSync(join(dir, "clip.mp4"), join(dir, "moved.mp4"));
    symlinkSync(join(dir, "moved.mp4"), join(dir, "clip.mp4"));
    expect((await get("clip.mp4")).status).toBe(404);
  });

  it("plays an older version only while its file is unchanged, and a copy at the same path is not the same file", async () => {
    const { get, dir } = setupVideo();
    expect((await get("clip.mp4", { range: "bytes=0-0" })).status).toBe(206);
    const copy = join(dir, "copied.mp4");
    writeFileSync(copy, MOVIE);
    rmSync(join(dir, "clip.mp4"));
    renameSync(copy, join(dir, "clip.mp4"));
    expect((await get("clip.mp4", { range: "bytes=0-0" })).status).toBe(404);
  });

  it("closes the file when the client goes away", async () => {
    const { files, folder } = setupVideo();
    const res = Object.assign(new Writable({ highWaterMark: 1, write() { /* a client that stopped reading */ } }), {
      writeHead() { return res; },
    });
    opened.length = 0;
    files.serve({ headers: {} } as never, res as never, `${folder}clip.mp4`, "GET");
    await expect.poll(() => opened[0]?.fd ?? -1).toBeGreaterThan(-1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened[0]!.fd).toBeGreaterThan(-1);
    res.destroy();
    await expect.poll(() => opened[0]!.fd).toBe(-1);
  });
});
