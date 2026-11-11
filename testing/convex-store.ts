/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { vi } from "vitest";
import schema from "../convex/schema";
import { hashToken } from "../convex/lib/auth";
import { signIntegration } from "../lib/integration-bridge";

// Test harness: a convex-test backend standing in for the production deployment, reached the way the frontend reaches
// it in production, through the signed /integrations HTTP action. Secrets below are fixtures, never real keys.

export const convexModules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.test.ts"]);
export const FIXTURE_INTEGRATION_SECRET = "fixture-integration-secret-".repeat(2);
/** 32 bytes of 0x2a, base64. */
export const FIXTURE_SEALING_KEY = btoa(String.fromCharCode(...new Array(32).fill(42)));

export type Backend = TestConvex<typeof schema>;

/** A fresh backend with the integration secret and sealing key set (call inside a test or beforeEach). */
export function convexStore(): Backend {
  vi.stubEnv("ORIGIN_INTEGRATION_SECRET", FIXTURE_INTEGRATION_SECRET);
  vi.stubEnv("ORIGIN_SEALING_KEY", FIXTURE_SEALING_KEY);
  return convexTest(schema, convexModules);
}

/** Calls one signed bridge operation on `backend`, exactly as lib/integration-bridge.ts does over HTTP. */
export async function signedBridge<T>(backend: Backend, operation: string, args: unknown): Promise<T> {
  const body = JSON.stringify({ at: Date.now(), operation, args });
  const response = await backend.fetch("/integrations", { method: "POST", body, headers: { "x-origin-signature": signIntegration(body) } });
  if (!response.ok) throw new Error(`Integration update failed (${response.status})`);
  return response.json() as Promise<T>;
}

/** Seeds an active user, a workspace they own and a Convex connector grant for `connectorToken` (if given). */
export async function seedWorkspace(backend: Backend, connectorTokens: string[] = []) {
  return backend.run(async ctx => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: "owner@fixture.test", name: "Owner", passwordHash: "x", salt: "x", iterations: 1, role: "user", status: "active", createdAt: now, updatedAt: now });
    const teamId = await ctx.db.insert("teams", { name: "Fixture", ownerUserId: userId, createdAt: now, updatedAt: now });
    for (const token of connectorTokens) {
      await ctx.db.insert("connectorGrants", { teamId, userId, tokenHash: await hashToken(token), name: "fixture", write: true, expiresAt: now + 86400000, createdAt: now, revoked: false });
    }
    return { userId, teamId };
  });
}

/** Connector tokens (by plaintext) whose Convex grant is revoked. */
export async function revokedConnectors(backend: Backend, tokens: string[]) {
  const hashes = new Map(await Promise.all(tokens.map(async token => [await hashToken(token), token] as const)));
  return backend.run(async ctx => (await ctx.db.query("connectorGrants").take(500)).filter(row => row.revoked && hashes.has(row.tokenHash)).map(row => hashes.get(row.tokenHash)!).sort());
}
