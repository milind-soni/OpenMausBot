// A lapsing license through the running server: the isolated fixture booted
// with a stand-in enterprise layer whose key expires soon, or expired a few
// days ago, read back from /api/edition, the startup log, and the config
// Settings reads as an admin and as a chat-only device. No real licence is
// involved; the fixture's home is disposable.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const DAY_MS = 24 * 60 * 60_000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

describe("license expiry through the running server", () => {
  let session: VerificationServer | undefined;
  let layerDir: string | undefined;

  afterEach(async () => {
    if (session) {
      console.info(JSON.stringify(session.info));
      await session.close();
    }
    if (layerDir) await removeTempDir(layerDir);
    session = undefined;
    layerDir = undefined;
  });

  const boot = async (expiresAt: string) => {
    layerDir = mkdtempSync(join(tmpdir(), "omb-expiring-layer-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"),
      `export async function register() { return { customer: "Fixture Co", features: ["budgets"], expiresAt: ${JSON.stringify(expiresAt)} }; }\n`);
    session = await launchVerificationServer(process.env, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
    const api = (path: string, init: RequestInit = {}) => fetch(`${session!.info.url}${path}`, init);
    const opened = (await (await api("/api/auth/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes: ["client"] }) })).json()) as { code: string };
    const member = ((await (await api("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: opened.code, label: "Member phone" }) })).json()) as { token: string }).token;
    return {
      edition: async () => (await api("/api/edition")).json() as Promise<any>,
      memberEdition: async () => (await api("/api/edition", { headers: { authorization: `Bearer ${member}` } })).json() as Promise<any>,
      adminConfig: async () => (await api("/api/config")).json() as Promise<any>,
      memberConfig: async () => (await api("/api/config", { headers: { authorization: `Bearer ${member}` } })).json() as Promise<any>,
      log: () => readFileSync(session!.info.logPath, "utf8"),
    };
  };

  it("warns inside the last 30 days: the day count on /api/edition, the log, and the admin's Settings only", async () => {
    const expiresAt = day(12);
    const server = await boot(expiresAt);
    const edition = await server.edition();
    expect(edition).toMatchObject({ edition: "enterprise", features: ["budgets"], expiresAt });
    expect(edition.expiresInDays).toBeGreaterThanOrEqual(11);
    expect(edition.expiresInDays).toBeLessThanOrEqual(12);
    expect(server.log()).toContain(`OMB_LICENSE_KEY expires on ${expiresAt}`);
    expect((await server.adminConfig()).edition).toEqual({
      edition: "enterprise", features: ["budgets"], license: { expiresAt, expiresInDays: edition.expiresInDays },
    });
    expect((await server.memberConfig()).edition).toEqual({ edition: "enterprise", features: ["budgets"] });
    // a member's /api/edition says what is entitled, not when it lapses
    const member = await server.memberEdition();
    expect(member).toMatchObject({ edition: "enterprise", features: ["budgets"] });
    expect(member).not.toHaveProperty("expiresInDays");
  }, 90_000);

  it("keeps the features working through the grace period and says until when", async () => {
    const expiresAt = day(-2);
    const server = await boot(expiresAt);
    const edition = await server.edition();
    expect(edition).toMatchObject({ edition: "enterprise", features: ["budgets"], expiresAt, graceEndsAt: day(5) });
    expect(edition.notice).toBe(`OMB_LICENSE_KEY expired on ${expiresAt}; enterprise features keep working until ${day(5)} while it is renewed`);
    expect(server.log()).toContain(`enterprise features keep working until ${day(5)}`);
    expect((await server.adminConfig()).edition.license).toMatchObject({ expiresAt, graceEndsAt: day(5) });
    expect((await server.memberConfig()).edition.license).toBeUndefined();
    const member = await server.memberEdition();
    expect(member).toMatchObject({ edition: "enterprise", features: ["budgets"] });
    for (const field of ["expiresInDays", "graceEndsAt", "notice"]) expect(member).not.toHaveProperty(field);
  }, 90_000);

  it("stays quiet far from expiry", async () => {
    const server = await boot(day(90));
    expect((await server.edition()).expiresInDays).toBeGreaterThan(30);
    expect((await server.adminConfig()).edition).toEqual({ edition: "enterprise", features: ["budgets"] });
    expect(server.log()).not.toContain("OMB_LICENSE_KEY expires on");
  }, 90_000);
});
