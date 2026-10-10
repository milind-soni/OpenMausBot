import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import type { LiveSettings } from "../shared/wire.ts";

describe("Live credential config authorization", () => {
  it("refuses paired client replacement and clearing while preserving owner/admin settings writes", async () => {
    const fixture = await launchVerificationServer();
    const remote = { "x-forwarded-for": "198.51.100.18", "x-forwarded-proto": "https" };
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${fixture.info.url}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() as {
        code?: string; token?: string; error?: string; scopes?: string[]; live?: LiveSettings;
      } };
    };
    const persistedLive = () => (JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")) as {
      live?: { key?: string; voice?: string; idleMinutes?: number };
    }).live;
    const pair = async (scopes: string[]) => {
      const opened = await api("POST", "/api/auth/pairing", { scopes });
      expect(opened.status).toBe(200);
      const paired = await api("POST", "/api/auth/pair", { code: opened.body.code, label: "Live auth fixture" }, remote);
      expect(paired.status).toBe(200);
      expect(paired.body.token).toBeTypeOf("string");
      return { ...remote, authorization: `Bearer ${paired.body.token}` };
    };

    try {
      const client = await pair(["client"]);
      const admin = await pair(["admin", "client"]);
      expect((await api("GET", "/api/auth/session", undefined, client)).body.scopes).toEqual(["client"]);

      expect((await api("PATCH", "/api/config", { live: { key: "fixture-live-owner" } })).status).toBe(200);
      expect((await api("PUT", "/api/config", { live: { key: "fixture-live-admin" } }, admin)).status).toBe(200);
      expect(persistedLive()?.key).toBe("fixture-live-admin");
      const before = readFileSync(join(fixture.info.dataDir, "config.json"), "utf8");
      for (const method of ["PUT", "PATCH"]) {
        for (const path of ["/api/config", "/api/config?secretStorage=external"]) {
          for (const key of ["fixture-live-client", ""]) {
            const refused = await api(method, path, { live: { key } }, client);
            expect(refused).toMatchObject({ status: 403, body: { error: expect.stringContaining("lacks the admin scope") } });
            expect(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).toBe(before);
          }
        }
      }
      const readable = await api("GET", "/api/config", undefined, client);
      expect(readable).toMatchObject({ status: 200, body: { live: { configured: true } } });
      expect(JSON.stringify(readable.body)).not.toContain("fixture-live-admin");
      expect(readable.body.live).not.toHaveProperty("key");

      expect((await api("PATCH", "/api/config", { live: { voice: "alloy", idleMinutes: 7 } })).status).toBe(200);
      expect((await api("PATCH", "/api/live/settings", { voice: "ash", idleMinutes: 9 }, admin)).status).toBe(200);
      expect(persistedLive()).toMatchObject({ key: "fixture-live-admin", voice: "ash", idleMinutes: 9 });
      // The separate phone-safe settings route cannot smuggle a key either.
      expect((await api("PATCH", "/api/live/settings", { key: "fixture-live-client" }, admin)).status).toBe(400);
      expect(persistedLive()?.key).toBe("fixture-live-admin");

      expect((await api("PATCH", "/api/config", { live: { key: "" } }, admin)).status).toBe(200);
      expect(persistedLive()?.key).toBe("");
      expect((await api("GET", "/api/config")).body.live?.configured).toBe(false);
      expect((await api("PUT", "/api/config", { live: { key: "fixture-live-restored" } })).status).toBe(200);
      expect(persistedLive()?.key).toBe("fixture-live-restored");
      console.info(JSON.stringify(fixture.info));
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
