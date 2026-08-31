// Verify the server falls back from an occupied OMB_PORT to the next free
// port, keeps the webhook listener in lock-step, and reports both resolved
// ports in its boot log.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const HOST = "127.0.0.1";

const SERVER_LOG_RE = /openmausbot server on http:\/\/127\.0\.0\.1:(\d+)/g;
const WEBHOOK_LOG_RE = /openmausbot webhook receiver on http:\/\/127\.0\.0\.1:(\d+)/g;

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

let home: string;
let child: ChildProcess | undefined;
let occupiedMain: Server;
let occupiedWebhook: Server;
let basePort = 0;
let resolvedPort = 0;
let resolvedWebhookPort = 0;

beforeAll(
  async () => {
    home = mkdtempSync(join(tmpdir(), "omb-port-fallback-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });

    for (let attempt = 0; attempt < 50; attempt++) {
      basePort = 50_000 + Math.floor(Math.random() * 10_000);
      occupiedMain = createServer();
      occupiedWebhook = createServer();

      try {
        await listenOn(occupiedMain, basePort);
        await listenOn(occupiedWebhook, basePort + 1);
      } catch {
        occupiedMain.close();
        occupiedWebhook.close();
        continue;
      }

      child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
        cwd: ROOT,
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: home,
          USERPROFILE: home,
          OMB_PORT: String(basePort),
          // Deliberately unset OMB_WEBHOOK_PORT so it is derived from the
          // resolved main port and must move with it.
        },
      });

      if (!child.stdout || !child.stderr) {
        throw new Error("spawned child has no stdio pipes");
      }

      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });

      const deadline = Date.now() + 30_000;
      let found = false;
      while (Date.now() < deadline) {
        const serverMatches = [...output.matchAll(SERVER_LOG_RE)];
        const webhookMatches = [...output.matchAll(WEBHOOK_LOG_RE)];
        if (serverMatches.length > 0 && webhookMatches.length > 0) {
          resolvedPort = Number(serverMatches[serverMatches.length - 1][1]);
          resolvedWebhookPort = Number(webhookMatches[webhookMatches.length - 1][1]);
          found = true;
          break;
        }
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      if (found) break;

      // Port setup may have collided with something transient, or the server
      // exited before logging. Tear down and try another pair.
      await waitForExit(child, { signal: "SIGTERM" });
      occupiedMain.close();
      occupiedWebhook.close();
    }

    if (resolvedPort === 0) {
      throw new Error("server did not report a resolved port after 50 attempts");
    }
  },
  60_000,
);

afterAll(async () => {
  occupiedMain?.close();
  occupiedWebhook?.close();
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("server port fallback on EADDRINUSE", () => {
  it("skips an occupied port and reports the resolved main and webhook ports", async () => {
    expect(resolvedPort).toBeGreaterThanOrEqual(basePort + 2);

    const health = await fetch(`http://${HOST}:${resolvedPort}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { app: string; pid: number };
    expect(healthBody.app).toBe("openmausbot");
    expect(healthBody.pid).toBe(child?.pid);

    const webhooks = await fetch(`http://${HOST}:${resolvedPort}/api/webhooks`);
    expect(webhooks.status).toBe(200);
    const { ingress } = (await webhooks.json()) as { ingress: { available: boolean; baseUrl: string } };
    expect(ingress.available).toBe(true);
    expect(ingress.baseUrl).toBe(`http://${HOST}:${resolvedWebhookPort}`);
    expect(resolvedWebhookPort).toBe(resolvedPort + 1);
  });
});
