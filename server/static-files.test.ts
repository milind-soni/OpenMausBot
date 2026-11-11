import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { serveStatic } from "./static-files.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-static-"));
writeFileSync(join(dir, "index.html"), "app");
writeFileSync(join(dir, "rail.html"), "rail");
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "assets", "rail-1a2b.js"), "js");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function get(path: string, staticDir: string = dir) {
  const answer: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
  const res = {
    writeHead(status: number, headers: Record<string, string>) { answer.status = status; answer.headers = headers; return res; },
    end(data: Buffer) { answer.body = String(data); },
  } as unknown as ServerResponse;
  return { served: serveStatic(res, path, staticDir), ...answer };
}

describe("serveStatic", () => {
  it("answers the window's rail with its own small page, never cached", () => {
    const rail = get("/rail");
    expect(rail.body).toBe("rail");
    expect(rail.headers).toMatchObject({ "content-type": "text/html", "cache-control": "no-cache", "x-frame-options": "DENY" });
  });

  it("answers the app's paths with the app, and keeps hashed assets for good", () => {
    expect(get("/").body).toBe("app");
    expect(get("/settings").body).toBe("app");
    expect(get("/rail/more").body).toBe("app");
    expect(get("/assets/rail-1a2b.js").headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });
});
