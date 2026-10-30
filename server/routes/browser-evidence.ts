// A member reads only conversations shown to them: bot visibility answers an unseen one with "not found" before this runs.
import { createReadStream } from "node:fs";

import type { BrowserEvidence } from "../browser-evidence.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BrowserEvidenceRouteDeps {
  evidence: Pick<BrowserEvidence, "list" | "imageFile" | "exportTar">;
  threadExists(threadId: string): boolean;
}

const GENERATION = /^[A-Za-z0-9-]{8,64}$/u;

function count(value: string | null, min: number, max: number): number | null | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,12}$/u.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

export function createBrowserEvidenceRoutes(deps: BrowserEvidenceRouteDeps): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    if (method !== "GET") return PASS;
    let m = /^\/api\/threads\/([\w-]+)\/evidence$/u.exec(path);
    if (m) {
      if (!deps.threadExists(m[1]!)) return json(res, 404, { error: "no such conversation" });
      const generation = url.searchParams.get("generation");
      const after = count(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
      const limit = count(url.searchParams.get("limit"), 1, 500);
      if ((generation !== null && !GENERATION.test(generation)) || after === null || limit === null) {
        return json(res, 400, { error: "generation, after and limit must be a turn id, a step number and 1-500" });
      }
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { threadId: m[1], ...deps.evidence.list(m[1]!, { ...(generation ? { generation } : {}), ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}) }) });
    }
    m = /^\/api\/threads\/([\w-]+)\/evidence\.tar$/u.exec(path);
    if (m) {
      if (!deps.threadExists(m[1]!)) return json(res, 404, { error: "no such conversation" });
      res.writeHead(200, {
        "content-type": "application/x-tar",
        "content-disposition": `attachment; filename="browser-steps-${m[1]}.tar"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      try { await deps.evidence.exportTar(m[1]!, res); res.end(); }
      catch { res.destroy(); }
      return;
    }
    m = /^\/api\/threads\/([\w-]+)\/evidence\/([A-Za-z0-9-]{8,64})\/(step-\d{6,12}\.jpg)$/u.exec(path);
    if (!m) return PASS;
    const file = deps.threadExists(m[1]!) ? deps.evidence.imageFile(m[1]!, m[2]!, m[3]!) : null;
    if (!file) return json(res, 404, { error: "no such screenshot" });
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    await new Promise<void>((resolve) => {
      const stream = createReadStream(file);
      stream.once("error", () => { res.destroy(); resolve(); });
      stream.once("end", resolve);
      res.once("close", () => { stream.destroy(); resolve(); });
      stream.pipe(res);
    });
  };
}
