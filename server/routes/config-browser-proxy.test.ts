import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../../scripts/control-omb.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const PROXY = "socks5://127.0.0.1:1080";

describe("Team Cloud browser proxy configuration", () => {
  it("refuses an admin's proxy change before writing shared config", async () => {
    const replies: Array<{ status: number; body: unknown }> = [];
    const route = createConfigRoutes({ cloudTeam: true } as unknown as ConfigRouteDeps);
    const auth: RequestAuth = {
      kind: "session",
      session: { id: "admin", scopes: ["admin", "client"], teamRole: "admin" } as never,
      via: "bearer",
      scopes: ["admin", "client"],
    };

    await route({
      req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method: "PATCH", auth,
      json: (_res: unknown, status: number, body: unknown) => { replies.push({ status, body }); },
      readBody: async () => ({ browserEngine: { egress: { proxy: "socks5://127.0.0.1:1080" } } }),
    } as unknown as Parameters<typeof route>[0]);

    expect(replies).toEqual([{ status: 403, body: { error: "Only the Team Cloud owner can configure the browser proxy." } }]);
  });
});

describe("local desktop browser proxy configuration", () => {
  it("saves a socks5 address, reports that it is saved, and does not echo the address", async () => {
    const fixture = await launchVerificationServer();
    const api = async (method: "GET" | "PATCH", body?: unknown) => {
      const response = await fetch(`${fixture.info.url}/api/config`, {
        method,
        headers: { "content-type": "application/json", origin: fixture.info.url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data: unknown = await response.json();
      return { status: response.status, data };
    };
    try {
      const before = await api("GET");
      expect(before.status).toBe(200);
      expect((before.data as { browserEngine?: { proxySaved?: boolean } }).browserEngine?.proxySaved).not.toBe(true);

      const saved = await api("PATCH", { browserEngine: { egress: { proxy: PROXY } } });
      expect(saved.status).toBe(200);

      const read = await api("GET");
      expect(read.status).toBe(200);
      expect((read.data as { browserEngine?: { proxySaved?: boolean } }).browserEngine?.proxySaved).toBe(true);
      expect(JSON.stringify(read.data)).not.toContain(PROXY);

      const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")) as {
        browserEngine?: { egress?: { proxy?: string } };
      };
      expect(disk.browserEngine?.egress?.proxy).toBe(PROXY);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
