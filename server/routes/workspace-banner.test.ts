import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { requiredScope } from "../request-auth.ts";
import { BANNER_MAX_BYTES, type StoredBanner } from "../workspace-banner.ts";
import { PASS } from "./table.ts";
import { BANNER_PATH, bannerSummary, bannerVersion, createWorkspaceBannerRoutes } from "./workspace-banner.ts";

/** Small pictures a real encoder made, each carrying a camera make and model, a colour profile and text (EXIF, ICC, and a
 * comment or XMP or text chunks). */
const sample = (name: string) => readFileSync(new URL(`../testing/fixtures/${name}`, import.meta.url));
const JPEG_WITH_METADATA = sample("banner-metadata.jpg"), PNG_WITH_METADATA = sample("banner-metadata.png");

/** One workspace's attachments and its banner record, in memory. */
function world() {
  const files = new Map<string, { bytes: Buffer; mime: string }>(), changes: Array<StoredBanner | null> = [];
  let banner: StoredBanner | null = null, next = 0, told = 0;
  const routes = createWorkspaceBannerRoutes({ changed: () => { told++; }, store: {
    current: () => banner,
    set: (value) => { banner = value; changes.push(value); },
    save: (bytes, mime) => { const name = `pic-${++next}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`; files.set(name, { bytes, mime }); return { name }; },
    read: (name) => files.get(name) ?? null,
    remove: (name) => { files.delete(name); },
  } });
  return { files, changes, routes, banner: () => banner, told: () => told };
}

/** A request through the handler, as the route table would make it (the auth gate already passed). */
async function call(routes: ReturnType<typeof world>["routes"], method: string, path: string, body?: Buffer, headers: Record<string, string> = {}) {
  const req = Readable.from(body ? [body] : []) as unknown as IncomingMessage;
  req.headers = { ...(body ? { "content-type": "image/png", "content-length": String(body.length) } : {}), ...headers };
  const res = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) as Buffer, headersSent: false, writableEnded: false,
    writeHead(status: number, head: Record<string, string>) { this.status = status; this.headers = head; this.headersSent = true; return this; },
    end(chunk?: Buffer) { if (chunk) this.body = chunk; this.writableEnded = true; return this; } };
  let answer: unknown;
  const json = (_res: unknown, status: number, value: unknown) => { res.status = status; answer = value; res.writableEnded = true; };
  const out = await routes({ req, res: res as unknown as ServerResponse, url: new URL(`http://x${path}`), path, method, auth: {} as never, json: json as never, readBody: (async () => ({})) as never });
  return { out, status: res.status, answer: answer as Record<string, unknown> | undefined, body: res.body, headers: res.headers };
}

describe("a workspace's banner over HTTP", () => {
  it("only an admin session changes it; anyone signed in here sees it; nobody else reaches it", () => {
    expect(requiredScope("GET", BANNER_PATH)).toBe("client");
    expect(requiredScope("PUT", BANNER_PATH)).toBe("admin");
    expect(requiredScope("DELETE", BANNER_PATH)).toBe("admin");
    expect(requiredScope("POST", BANNER_PATH)).toBe("admin");
  });

  it("a picture is checked and cleaned before it is kept, the old one goes, and the page learns a version, never a file name", async () => {
    const w = world();
    expect((await call(w.routes, "GET", BANNER_PATH)).status).toBe(404);
    const put = await call(w.routes, "PUT", BANNER_PATH, PNG_WITH_METADATA);
    expect(put.status).toBe(200);
    expect(put.answer).toEqual({ banner: { version: bannerVersion("pic-1.png"), width: 12, height: 6 } });
    expect(JSON.stringify(put.answer).includes("pic-1")).toBe(false);
    expect(w.files.get("pic-1.png")!.bytes.includes("Secret")).toBe(false);
    const got = await call(w.routes, "GET", BANNER_PATH);
    expect([got.status, got.headers["content-type"], got.headers["cache-control"], got.headers["x-content-type-options"]]).toEqual([200, "image/png", "private, no-cache", "nosniff"]);
    expect(got.body.equals(w.files.get("pic-1.png")!.bytes)).toBe(true);
    expect((await call(w.routes, "GET", BANNER_PATH, undefined, { "if-none-match": got.headers.etag! })).status).toBe(304);

    await call(w.routes, "PUT", BANNER_PATH, JPEG_WITH_METADATA, { "content-type": "image/jpeg" });
    expect([...w.files.keys()]).toEqual(["pic-2.jpg"]);
    expect(w.banner()).toEqual({ name: "pic-2.jpg", width: 12, height: 6 });
    expect((await call(w.routes, "DELETE", BANNER_PATH)).answer).toEqual({ banner: null });
    expect([w.files.size, w.banner()]).toEqual([0, null]);
    expect(w.changes.map((change) => change?.name ?? null)).toEqual(["pic-1.png", "pic-2.jpg", null]);
    expect(w.told(), "every open page heard of each change").toBe(3);
  });

  it("anything else is refused in plain words, and the banner kept stays", async () => {
    const w = world();
    await call(w.routes, "PUT", BANNER_PATH, PNG_WITH_METADATA);
    for (const [body, status, refusal] of [
      [Buffer.from("<svg/>"), 415, "format"],
      [Buffer.concat([PNG_WITH_METADATA, Buffer.alloc(BANNER_MAX_BYTES)]), 413, "size"],
      [PNG_WITH_METADATA.subarray(0, 40), 422, "damaged"],
    ] as const) {
      const answer = await call(w.routes, "PUT", BANNER_PATH, body);
      expect([answer.status, answer.answer?.refusal]).toEqual([status, refusal]);
      expect(typeof answer.answer?.error).toBe("string");
    }
    const lying = await call(w.routes, "PUT", BANNER_PATH, Buffer.concat([PNG_WITH_METADATA, Buffer.alloc(BANNER_MAX_BYTES)]), { "content-length": "100" });
    expect([lying.status, lying.answer?.refusal], "a body bigger than it said is cut off at the limit").toEqual([413, "size"]);
    expect(w.banner()?.name).toBe("pic-1.png");
    expect([...w.files.keys()]).toEqual(["pic-1.png"]);
    expect(w.told(), "a refusal changes nothing").toBe(1);
  });

  it("another path is not its own", async () => {
    expect((await call(world().routes, "GET", "/api/workspace/other")).out).toBe(PASS);
    expect(bannerSummary(null)).toBeNull();
  });
});
