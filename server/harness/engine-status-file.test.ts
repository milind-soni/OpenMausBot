import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { engineStatusFile, flushEngineStatusFiles } from "./engine-status-file.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await removeTempDir(dir);
  dir = undefined;
});

it("writes what the save delay still holds when the process exits cleanly, once", () => {
  dir = mkdtempSync(join(tmpdir(), "omb-engine-status-"));
  const file = join(dir, "providers", "engine-status.json");
  const status = engineStatusFile(file);
  const row = { instanceId: "work", driverKind: "antigravityAgent", cli: "agy", snapshot: { state: "available" as const, authenticated: true } };
  status.save([row]);
  expect(existsSync(file)).toBe(false);
  flushEngineStatusFiles();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, engines: [row] });
  const read = status.read(() => ({ driverKind: "antigravityAgent", cli: "agy" }));
  expect(read.get("work")).toEqual({ state: "available", authenticated: true });
  flushEngineStatusFiles();
  expect(process.listeners("exit").filter((listener) => listener === flushEngineStatusFiles)).toHaveLength(1);
});
