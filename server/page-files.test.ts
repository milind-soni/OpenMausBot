import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AppDocs } from "./app-docs.ts";
import { createPageFiles, pageFilePath, PAGE_FILES_PREFIX } from "./page-files.ts";

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
