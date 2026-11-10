// Settings → General → Training data: what is kept on this computer, and how sharing is going (GET), the whole of it
// as one file (GET .jsonl), and deleting it (DELETE). Admin-scope routes, so only the owner's own app.
import { createReadStream } from "node:fs";

import type { TrainingLog } from "../training-log.ts";
import type { TrainingUploader } from "../training-upload.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TrainingDataRouteDeps {
  log: TrainingLog;
  uploader: Pick<TrainingUploader, "status">;
  /** False on a Team Cloud or a hosted workspace: other people's conversations are never recorded, so Settings hides it. */
  available: () => boolean;
}

export function createTrainingDataRoutes(deps: TrainingDataRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path === "/api/training-data" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      return void json(res, 200, { ...deps.log.summary(), available: deps.available(), upload: deps.uploader.status() });
    }
    if (path === "/api/training-data" && method === "DELETE") {
      deps.log.clear();
      return void json(res, 200, { ok: true, ...deps.log.summary() });
    }
    if (path !== "/api/training-data.jsonl" || method !== "GET") return PASS;
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": 'attachment; filename="mausbot-training-data.jsonl"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    for (const day of deps.log.days()) {
      const file = deps.log.file(day);
      if (!file) continue;
      const done = await new Promise<boolean>((resolve) => {
        const stream = createReadStream(file);
        stream.once("error", () => resolve(true));
        stream.once("end", () => resolve(true));
        res.once("close", () => { stream.destroy(); resolve(false); });
        stream.pipe(res, { end: false });
      });
      if (!done) return;
    }
    res.end();
  };
}
