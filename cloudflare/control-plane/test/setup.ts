import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll } from "vitest";

import { readConfig } from "../src/config";
import { forgetCachedCapacity } from "../src/tunnel-capacity";

declare global {
  namespace Cloudflare {
    interface Env {
      MIGRATION_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  await forgetCachedCapacity(readConfig(env));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM otp_recipient_rate_limits"),
    env.DB.prepare("DELETE FROM control_action_rate_limits"),
    env.DB.prepare("DELETE FROM installation_action_rate_limits"),
    env.DB.prepare("DELETE FROM installation_endpoints"),
    // A missing row reads as an empty snapshot (never scanned, never refused).
    env.DB.prepare("DELETE FROM managed_endpoint_account_capacity"),
    env.DB.prepare("DELETE FROM installation_credentials"),
    env.DB.prepare("DELETE FROM installations"),
    env.DB.prepare('DELETE FROM "session"'),
    env.DB.prepare('DELETE FROM "account"'),
    env.DB.prepare('DELETE FROM "verification"'),
    env.DB.prepare('DELETE FROM "rateLimit"'),
    env.DB.prepare('DELETE FROM "user"'),
  ]);
});
