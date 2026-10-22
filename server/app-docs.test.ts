import { mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { APP_DOCS_SWEEP_GRACE_MS, AppDocs } from "./app-docs.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "omb-app-docs-")), "app-docs");
const files = (dir: string, kind: string) => { try { return readdirSync(join(dir, kind)); } catch { return []; } };
const age = (dir: string, ms: number) => {
  const then = new Date(Date.now() - ms);
  for (const kind of ["html", "data", "doc"]) for (const name of files(dir, kind)) utimesSync(join(dir, kind, name), then, then);
};

describe("AppDocs", () => {
  it("stores a page and reads it back, by a content id", () => {
    const dir = fresh();
    const docs = new AppDocs(dir);
    const put = docs.put({ source: "html", html: "<p>héllo</p>" });
    expect(put).toEqual({ ok: true, doc: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: Buffer.byteLength("<p>héllo</p>") });
    if (!put.ok) throw new Error("not stored");
    expect(docs.read(put.doc)).toEqual({ doc: put.doc, source: "html", html: "<p>héllo</p>" });
    // Windows has no POSIX mode bits (every file reads 0o666 there).
    if (process.platform !== "win32") expect(statSync(join(dir, "html", files(dir, "html")[0]!)).mode & 0o777).toBe(0o600);
  });

  it("keeps one copy of a template across calls, and one document per distinct row", () => {
    const docs = new AppDocs(fresh());
    const template = "<html><body>view</body></html>";
    const a = docs.put({ source: "mcp", html: template, data: { toolInput: { n: 1 }, tool: { name: "t" } } });
    const b = docs.put({ source: "mcp", html: template, data: { toolInput: { n: 2 }, tool: { name: "t" } } });
    const again = docs.put({ source: "mcp", html: template, data: { toolInput: { n: 1 }, tool: { name: "t" } } });
    if (!a.ok || !b.ok || !again.ok) throw new Error("not stored");
    expect(a.doc).not.toBe(b.doc);
    expect(again.doc).toBe(a.doc);
    const dir = (docs as unknown as { dir: string }).dir;
    expect(files(dir, "html")).toHaveLength(1);
    expect(files(dir, "data")).toHaveLength(2);
    expect(docs.read(b.doc)?.data).toEqual({ toolInput: { n: 2 }, tool: { name: "t" } });
  });

  it("refuses a new document past the ceiling and writes nothing, but still serves what it holds", () => {
    const dir = fresh();
    const docs = new AppDocs(dir, { maxBytes: 600 });
    const first = docs.put({ source: "html", html: "a".repeat(300) });
    expect(first.ok).toBe(true);
    expect(docs.put({ source: "html", html: "b".repeat(300) })).toEqual({ ok: false, reason: "too-large" });
    expect(files(dir, "html")).toHaveLength(1);
    expect(docs.put({ source: "html", html: "a".repeat(300) })).toEqual(first);
    expect(new AppDocs(dir, { maxBytes: 600 }).put({ source: "html", html: "c".repeat(300) }).ok).toBe(false);
  });

  it("reads only well-formed ids", () => {
    const docs = new AppDocs(fresh());
    for (const id of ["", "../etc/passwd", "a".repeat(63), "A".repeat(64), `${"a".repeat(64)}/../x`]) expect(docs.read(id), id).toBeNull();
    expect(docs.read("a".repeat(64))).toBeNull();
  });

  it("sweeps what no row names, keeps what one does, and never touches a file younger than the grace", () => {
    const dir = fresh();
    const docs = new AppDocs(dir);
    const kept = docs.put({ source: "mcp", html: "<p>shared</p>", data: { tool: { name: "kept" } } });
    const dropped = docs.put({ source: "mcp", html: "<p>shared</p>", data: { tool: { name: "dropped" } } });
    const alone = docs.put({ source: "html", html: "<p>alone</p>" });
    if (!kept.ok || !dropped.ok || !alone.ok) throw new Error("not stored");
    expect(docs.sweep([])).toBe(0);
    age(dir, APP_DOCS_SWEEP_GRACE_MS + 1_000);
    const before = docs.usage();
    expect(docs.sweep([kept.doc, "not-an-id"])).toBe(4); // two manifests, one data blob, one html blob
    expect(docs.read(kept.doc)?.html).toBe("<p>shared</p>");
    expect(docs.read(dropped.doc)).toBeNull();
    expect(docs.read(alone.doc)).toBeNull();
    expect(files(dir, "html")).toHaveLength(1);
    expect(docs.usage()).toBeLessThan(before);
    // Storing an old blob again refreshes it, so a sweep between the put and its row cannot take it.
    age(dir, APP_DOCS_SWEEP_GRACE_MS + 1_000);
    const reput = docs.put({ source: "mcp", html: "<p>shared</p>", data: { tool: { name: "dropped" } } });
    if (!reput.ok) throw new Error("not stored");
    expect(docs.sweep([])).toBe(2); // only the other document's manifest and data are old now
    expect(docs.read(reput.doc)?.html).toBe("<p>shared</p>");
  });
});
