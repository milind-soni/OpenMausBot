import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { mcpOAuthRedirectUri } from "../mcp-oauth.ts";
import { hostTimeout } from "./host-timeout.ts";
import { CLAIM_TTL_MS, canBind, claimPath, ephemeralFloor, freePortBlock, withFreeSignInPort } from "./ports.ts";

// This file's tests share one exclusive slice of the default range, away from every other suite.
const FROM = 46_000;
const SPAN = 240;

const listenOn = (server: Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

async function waitFor(condition: () => boolean, what: string, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Hold the port with a real listener until the watcher drops its claim, then let go. */
async function releaseByBinding(port: number): Promise<void> {
  if (!existsSync(claimPath(port))) return;
  const server = createServer();
  try {
    await listenOn(server, port);
    await waitFor(() => !existsSync(claimPath(port)), `the claim on port ${port} to clear`);
  } finally {
    await closeServer(server);
  }
}

const writeClaim = (port: number, pid: number, at: number): void =>
  writeFileSync(claimPath(port), JSON.stringify({ pid, at }));

// A failed assertion must not leave this file's claims standing for the rest of the run.
afterEach(() => {
  for (let port = FROM; port < FROM + SPAN; port++) {
    const path = claimPath(port);
    if (existsSync(path)) unlinkSync(path);
  }
});

describe("freePortBlock claims", () => {
  it("two concurrent freePortBlock calls never share a base", async () => {
    const first = await freePortBlock([0, 1], FROM, 200);
    const [second, third] = await Promise.all([
      freePortBlock([0, 1], FROM, 200),
      freePortBlock([0, 1], FROM, 200),
    ]);
    const handed = [first, second, third];
    expect(new Set(handed.flatMap((base) => [base, base + 1])).size).toBe(6);
    // The first block is claimed and still unbound: an exact-base probe must come back empty.
    await expect(freePortBlock([0], first, 1)).rejects.toThrow("no free port block");
    for (const port of handed.flatMap((base) => [base, base + 1])) await releaseByBinding(port);
  });

  it("a claim disappears once a real listener takes the port", async () => {
    const base = await freePortBlock([0, 1], FROM, 200);
    expect(existsSync(claimPath(base))).toBe(true);
    expect(existsSync(claimPath(base + 1))).toBe(true);
    const listener = createServer();
    try {
      await listenOn(listener, base);
      await waitFor(() => !existsSync(claimPath(base)), "the claim to clear once a listener binds");
      await expect(freePortBlock([0], base, 1)).rejects.toThrow("no free port block");
    } finally {
      await closeServer(listener);
    }
    try {
      await expect(freePortBlock([0], base, 1)).resolves.toBe(base);
    } finally {
      await releaseByBinding(base);
      await releaseByBinding(base + 1);
    }
  });

  it("a stale claim from a dead process is reclaimable", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    expect(deadPid).toBeGreaterThan(0);

    const deadBase = await freePortBlock([0], FROM, 200);
    writeClaim(deadBase, deadPid, Date.now());
    await expect(freePortBlock([0], deadBase, 1)).resolves.toBe(deadBase);
    await releaseByBinding(deadBase);

    const agedBase = await freePortBlock([0], FROM, 200);
    writeClaim(agedBase, process.pid, Date.now() - CLAIM_TTL_MS - 1_000);
    await expect(freePortBlock([0], agedBase, 1)).resolves.toBe(agedBase);
    await releaseByBinding(agedBase);
  });

  it("a narrow span still finds bases across repeated cycles", async () => {
    for (let cycle = 0; cycle < 45; cycle++) {
      const base = await freePortBlock([0], FROM, 40);
      expect(base).toBeGreaterThanOrEqual(FROM);
      expect(base).toBeLessThan(FROM + 40);
      const listener = createServer();
      try {
        await listenOn(listener, base);
        await waitFor(() => !existsSync(claimPath(base)), `cycle ${cycle}'s claim to clear`);
      } finally {
        await closeServer(listener);
      }
    }
  }, hostTimeout(60_000));

  it("withFreeSignInPort lands below the ephemeral floor and skips claimed ports", async () => {
    const url = "http://127.0.0.1:8799/mcp";
    const floor = ephemeralFloor();
    let claimedPort = 0;
    for (let attempt = 0; attempt < 200 && claimedPort === 0; attempt++) {
      const candidate = new URL(url);
      candidate.searchParams.set("app", String(attempt));
      const port = Number(new URL(mcpOAuthRedirectUri(candidate.toString())).port);
      if (port < floor && await canBind(port)) claimedPort = port;
    }
    expect(claimedPort).toBeGreaterThan(0);
    try {
      writeClaim(claimedPort, process.pid, Date.now());
      const result = new URL(await withFreeSignInPort(url));
      expect(Number(result.port)).toBeLessThan(floor);
      expect(Number(result.port)).not.toBe(claimedPort);
      expect(existsSync(claimPath(claimedPort))).toBe(true);
    } finally {
      if (existsSync(claimPath(claimedPort))) unlinkSync(claimPath(claimedPort));
    }
  });
});
