import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublishedPageFiles } from "./owner-files.ts";
import { createOwnerPageLinks } from "./owner-links.ts";

const PAGE = "abcdefghijklmnopqrstuvwxyz";
let dir: string;
let files: PublishedPageFiles;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-owner-links-"));
  files = new PublishedPageFiles(join(dir, "owner-pages"));
  files.save(PAGE, [{ path: "index.html", data: Buffer.from("<!doctype html><h1>Traffic</h1>") }, { path: "data.csv", data: Buffer.from("a,1") }]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function request(headers: Record<string, string> = {}): IncomingMessage {
  // SAFETY: the route reads only headers.
  return { headers } as unknown as IncomingMessage;
}

function response() {
  const sent: { status?: number; headers?: Record<string, string>; body?: unknown } = {};
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => { sent.status = status; sent.headers = headers; },
    end: (body?: unknown) => { sent.body = body; },
  } as unknown as ServerResponse;
  return { res, sent };
}

const linksFor = (options: { ownerPage?: boolean; now?: () => number } = {}) =>
  createOwnerPageLinks({ files, ownerPage: () => options.ownerPage ?? true, ...(options.now ? { now: options.now } : {}) });

describe("an owner-only page's token folder", () => {
  it("serves its index and files with a sandboxed policy and no cache, to GET and HEAD", () => {
    const links = linksFor(), folder = links.folder(PAGE, { key: "session:s1", allowed: () => true });
    const index = response();
    expect(links.serve(request({ host: "cloud.example.test", "x-forwarded-proto": "https" }), index.res, folder, "GET")).toBe(true);
    expect(index.sent).toMatchObject({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "access-control-allow-origin": "*" } });
    expect(String(index.sent.headers!["content-security-policy"])).toContain("sandbox allow-scripts");
    expect(String(index.sent.headers!["content-security-policy"])).toContain("https://cloud.example.test");
    expect(String(index.sent.body)).toBe("<!doctype html><h1>Traffic</h1>");
    const csv = response();
    links.serve(request(), csv.res, `${folder}data.csv`, "HEAD");
    expect(csv.sent).toMatchObject({ status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
    expect(csv.sent.body).toBeUndefined();
  });

  it("refuses a token whose page is gone, whose viewer may no longer see it, or that was never minted", () => {
    let allowed = true, pageExists = true;
    const links = createOwnerPageLinks({ files, ownerPage: () => pageExists });
    const folder = links.folder(PAGE, { key: "session:s1", allowed: () => allowed });
    allowed = false;
    const refused = response();
    links.serve(request(), refused.res, folder, "GET");
    expect(refused.sent).toMatchObject({ status: 404 });
    allowed = true;
    const unknown = response();
    links.serve(request(), unknown.res, "/api/owner-page-files/not-a-token/index.html", "GET");
    expect(unknown.sent).toMatchObject({ status: 404 });
    pageExists = false;
    const gone = response();
    links.serve(request(), gone.res, folder, "GET");
    expect(gone.sent).toMatchObject({ status: 404 });
    pageExists = true;
    const traversal = response();
    links.serve(request(), traversal.res, `${folder}../secret.txt`, "GET");
    expect(traversal.sent).toMatchObject({ status: 400 });
  });

  it("gives one viewer the same folder while it is in use, another viewer its own, and forgets both after a day unused", () => {
    let now = 1_000;
    const links = linksFor({ now: () => now });
    const viewer = { key: "session:s1", allowed: () => true };
    const first = links.folder(PAGE, viewer);
    expect(links.folder(PAGE, viewer)).toBe(first);
    const other = links.folder(PAGE, { key: "session:s2", allowed: () => true });
    expect(other).not.toBe(first);
    now += 24 * 60 * 60_000 + 1;
    const answer = response();
    links.serve(request(), answer.res, first, "GET");
    expect(answer.sent).toEqual({ status: 404, headers: expect.any(Object), body: "Not found." });
  });
});
