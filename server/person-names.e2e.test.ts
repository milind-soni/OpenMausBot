import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

describe("names people choose on a self-hosted server", () => {
  it("labels each signed-in person's lines with the name they chose, while the owner's computer keeps the profile's", async () => {
    const fixture = await launchVerificationServer();
    const remote = { "x-forwarded-for": "198.51.100.21", "x-forwarded-proto": "https" };
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${fixture.info.url}${path}`, {
        method, headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() as any };
    };
    const pair = async (label: string) => {
      const opened = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
      const paired = await api("POST", "/api/auth/pair", { code: opened.body.code, label }, remote);
      expect(paired.status).toBe(200);
      return { ...remote, authorization: `Bearer ${paired.body.token}` };
    };
    try {
      expect((await api("PUT", "/api/config", { profile: { name: "Ada Lovelace" } })).status).toBe(200);
      const grace = await pair("Grace's laptop");
      const guest = await pair("Guest phone");
      expect((await api("GET", "/api/me")).status).toBe(404);
      expect((await api("GET", "/api/me", undefined, guest)).body).toEqual({ displayName: "", shownAs: "Guest phone" });
      expect((await api("PUT", "/api/me", { displayName: "Grace\u0007" }, grace)).status).toBe(400);
      expect((await api("PUT", "/api/me", { displayName: " Grace Hopper " }, grace)).body).toEqual({ displayName: "Grace Hopper", shownAs: "Grace Hopper" });
      if (process.platform !== "win32") expect(statSync(join(fixture.info.dataDir, "person-names.json")).mode & 0o777).toBe(0o600);

      const bot = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
      for (const [headers, text] of [[grace, "from grace"], [guest, "from the guest"]] as const) {
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { text }, headers)).status).toBe(202);
      }
      const lines = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as Array<{ text?: string; sender?: { name: string } }>;
      expect(lines.find((line) => line.text === "from grace")?.sender?.name).toBe("Grace Hopper");
      expect(lines.find((line) => line.text === "from the guest")?.sender?.name).toBe("Guest phone");
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
