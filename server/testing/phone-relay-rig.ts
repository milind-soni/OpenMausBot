// The real server with OMB_PHONE_RELAY=1 for tests, beside a fake control plane that grants relay tokens and the fake
// relay those tokens open.
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verificationServerArgs, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { b64u, ed25519RawPublicKey, mintRelayToken } from "../../companion/src/e2e/credentials.ts";
import { startFakeRelay, type FakeRelay } from "../../companion/test/e2e/fake-relay.ts";
import { waitFor } from "../../companion/test/e2e/wait.ts";
import { removeTempDir, waitForExit } from "./cleanup.ts";
import { freePortBlock } from "./ports.ts";

export interface RelayServer {
  child: ChildProcess;
  dataDir: string;
  logPath: string;
  base: string;
}

export interface PhoneRelayRig {
  relay: FakeRelay;
  hostId: Buffer;
  /** The installation credential every booted server is signed in with. */
  credential: string;
  /** Each relay-token request body, in order. */
  tokenRequests: unknown[];
  /** A real server in a new data dir, signed in for the relay as `login --relay` leaves it: a credential, no tunnel address. */
  boot(extra?: Record<string, string>): Promise<RelayServer>;
  /** Stops every booted server, then the relay and the control plane. */
  close(): Promise<void>;
}

export async function startPhoneRelayRig(): Promise<PhoneRelayRig> {
  const signingKey = generateKeyPairSync("ed25519").privateKey;
  const hostId = randomBytes(16);
  const credential = `omb_install_${randomBytes(16).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
  const tokenRequests: unknown[] = [];
  const servers: RelayServer[] = [];
  const relay = await startFakeRelay({ keys: new Map([["k1", ed25519RawPublicKey(signingKey)]]) });
  const controlPlane = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method !== "POST" || req.url !== "/v1/installations/self/relay-token" || req.headers.authorization !== `Bearer ${credential}`) {
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    }
    tokenRequests.push(JSON.parse(raw));
    const iat = Math.floor(Date.now() / 1000);
    const token = mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: "test-install", iat, exp: iat + 43_200 }, signingKey);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      token, hostId: b64u(hostId), nodes: ["relay1.openmausbot.com"], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000,
    }));
  });
  await new Promise<void>((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));

  return {
    relay, hostId, credential, tokenRequests,
    async boot(extra = {}) {
      const port = await freePortBlock([0, 1]);
      const dir = mkdtempSync(join(tmpdir(), "omb-phone-relay-e2e-"));
      mkdirSync(join(dir, "tmp"), { recursive: true });
      writeFileSync(join(dir, "tunnel-account.json"), JSON.stringify({ companionInstallationCredential: credential }), { mode: 0o600 });
      const env = {
        ...verificationServerEnvironment(process.env, dir, port),
        OMB_PHONE_RELAY: "1",
        OMB_PHONE_RELAY_URL: relay.url,
        OMB_CONTROL_PLANE_URL: `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`,
        ...extra,
      };
      const log = join(dir, "server.log");
      const fd = openSync(log, "a", 0o600);
      const child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", fd, fd] });
      closeSync(fd);
      const server = { child, dataDir: dir, logPath: log, base: `http://127.0.0.1:${port}` };
      servers.push(server);
      await waitFor(async () => (await fetch(`${server.base}/api/health`).then((r) => r.json(), () => null) as { app?: string } | null)?.app === "openmausbot", 30_000);
      return server;
    },
    async close() {
      for (const server of servers) {
        await waitForExit(server.child, { signal: "SIGTERM", graceMs: 15_000 });
        await removeTempDir(server.dataDir);
      }
      await relay.close();
      await new Promise((resolve) => controlPlane.close(resolve));
    },
  };
}
