import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LOCAL_APP_VERSIONS } from "../../shared/local-apps.ts";
import { keptVersions, localAppDocRefs, localAppsFile, LocalAppsStore } from "./store.ts";

const doc = (n: number) => n.toString(16).padStart(64, "0");
const versions = (count: number) => Array.from({ length: count }, (_, rev) => ({ rev, doc: doc(rev + 1), at: rev }));

describe("local apps store", () => {
  it("keeps the newest versions, and the pinned one among them", () => {
    expect(keptVersions(versions(LOCAL_APP_VERSIONS + 5)).map((one) => one.rev)).toEqual(Array.from({ length: LOCAL_APP_VERSIONS }, (_, at) => at + 5));
    const pinned = keptVersions(versions(LOCAL_APP_VERSIONS + 5), 2);
    expect(pinned).toHaveLength(LOCAL_APP_VERSIONS);
    expect(pinned[0]!.rev).toBe(2);
    expect(pinned.at(-1)!.rev).toBe(LOCAL_APP_VERSIONS + 4);
  });

  it("writes one file another store reads back, and names every kept document", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-local-apps-"));
    const store = new LocalAppsStore(dir);
    const app = store.add({ name: "Board", botId: "b1", threadId: "t1", messageId: "m1", versions: versions(2), manifest: { name: "Board" } });
    expect(new LocalAppsStore(dir).get(app.id)).toMatchObject({ name: "Board", versions: [{ rev: 0 }, { rev: 1 }] });
    expect(localAppDocRefs(dir)).toEqual([doc(1), doc(2)]);
    const pinned = store.update(app.id, (record) => ({ ...record, pinnedRev: 7 }));
    expect(pinned?.pinnedRev).toBeUndefined();
  });

  it("starts empty on a file it can't read", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-local-apps-"));
    writeFileSync(localAppsFile(dir), "{not json");
    expect(new LocalAppsStore(dir).list()).toEqual([]);
    writeFileSync(localAppsFile(dir), JSON.stringify({ version: 1, apps: [{ id: "la_short", name: "x" }] }));
    expect(localAppDocRefs(dir)).toEqual([]);
  });
});
