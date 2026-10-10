// Explicit --import in the isolated visibility fixture only; never bundled.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DATA_DIR } from "../config.ts";
import { MessageSearchWorker } from "../message-search-worker.ts";

const search = MessageSearchWorker.prototype.search;
MessageSearchWorker.prototype.search = async function (...args) {
  const hits = await search.apply(this, args);
  const hold = join(DATA_DIR, "hold-search-result");
  if (existsSync(hold)) {
    // Signal only after real SQLite results exist, before the HTTP await resumes.
    writeFileSync(`${hold}.ready`, JSON.stringify(hits));
    const deadline = Date.now() + 10_000;
    while (existsSync(hold)) {
      if (Date.now() > deadline) throw new Error("Search fixture result was not released");
      await delay(5);
    }
  }
  return hits;
};
