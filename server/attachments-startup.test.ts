import type { SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// Obstruct only the attachments directory in the launcher's disposable home.
// The real child still boots normally and handles real HTTP requests.
vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return {
    ...childProcess,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const dataDir = options.env?.OMB_DATA_DIR;
      if (!dataDir || !args.includes(join(process.cwd(), "server", "index.ts"))) {
        throw new Error("Expected the isolated verification server");
      }
      writeFileSync(join(dataDir, "attachments"), "fixture obstruction");
      return childProcess.spawn(command, args, options);
    },
  };
});

it("starts despite attachment cleanup failure and initializes quota after the directory is repaired", async () => {
  const session = await launchVerificationServer();
  try {
    await expect(runControlOmb(["doctor", "--url", session.info.url])).resolves.toMatchObject({ ok: true });
    expect(readFileSync(session.info.logPath, "utf8")).toContain("attachments: startup partial cleanup failed:");
    const upload = () => fetch(`${session.info.url}/api/files?name=fixture.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    const blocked = await upload();
    expect(blocked.status).toBe(500);
    await blocked.text();

    unlinkSync(join(session.info.dataDir, "attachments"));
    const recovered = await upload();
    expect(recovered.status).toBe(201);
    const saved = await recovered.json() as { path: string; bytes: number };
    expect(saved.path.startsWith(join(session.info.dataDir, "attachments"))).toBe(true);
    expect(saved.bytes).toBe(5);
    expect(readFileSync(saved.path, "utf8")).toBe("hello");
  } finally {
    await session.close();
  }
  expect(existsSync(session.info.dataDir)).toBe(false);
}, 30_000);
