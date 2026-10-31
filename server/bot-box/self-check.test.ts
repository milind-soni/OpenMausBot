import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { BOX_BRIDGE_SCRIPT } from "./box.ts";
import { runBoxSelfCheck } from "./self-check.ts";

vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  return { ...cp, spawn: vi.fn(cp.spawn) };
});
vi.mock("node:http", async (original) => {
  const http = await original<typeof import("node:http")>();
  return { ...http, createServer: vi.fn(http.createServer) };
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

describe.runIf(process.platform === "linux")("self-check resource cleanup", () => {
  it("removes listeners, the canary and fixture files when a required mount is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-check-cleanup-"));
    const missing = join(root, "missing-code");
    vi.mocked(spawn).mockClear();
    vi.mocked(createServer).mockClear();
    vi.mocked(writeFileSync).mockClear();
    const children = () => vi.mocked(spawn).mock.results.flatMap((result) => result.type === "return" ? [result.value] : []);
    const servers = () => vi.mocked(createServer).mock.results.flatMap((result) => result.type === "return" ? [result.value] : []);
    const hostTmpFiles = () => vi.mocked(writeFileSync).mock.calls.flatMap(([file]) =>
      typeof file === "string" && basename(file).startsWith("omb-box-check-") ? [file] : []);
    try {
      await expect(runBoxSelfCheck({
        bwrap: "/unused-bwrap", bridge: { socat: null, bridgeScript: BOX_BRIDGE_SCRIPT, node: process.execPath },
        root, codeRoots: [missing], denyEnv: new Set(), publicTarget: null,
      })).rejects.toMatchObject({ code: "ENOENT", path: missing });
      await vi.waitFor(() => {
        expect({
          listeners: servers().filter((server) => server.listening).length,
          canaries: children().filter((child) => child.exitCode === null && child.signalCode === null).length,
          fixture: readdirSync(root),
          hostTmpFiles: hostTmpFiles().filter((file) => existsSync(file)),
        }).toEqual({ listeners: 0, canaries: 0, fixture: [], hostTmpFiles: [] });
      });
    } finally {
      await Promise.all([
        ...children().map((child) => new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        })),
        ...servers().map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      ]);
      for (const file of hostTmpFiles()) rmSync(file, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
