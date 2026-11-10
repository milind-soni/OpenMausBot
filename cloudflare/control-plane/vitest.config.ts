import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

const root = fileURLToPath(new URL(".", import.meta.url));
const TEST_AUTH_SECRET = "test-only-better-auth-secret-with-more-than-32-characters";
const TEST_CLOUDFLARE_TOKEN = "test-only-cloudflare-api-token-with-no-real-access";
const wranglerPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
// The production account list, for the test that checks it parses.
const productionAccounts = unstable_readConfig({ config: wranglerPath }).vars.CLOUDFLARE_ENDPOINT_ACCOUNTS ?? [];
process.env.BETTER_AUTH_SECRET ??= TEST_AUTH_SECRET;
process.env.CLOUDFLARE_API_TOKEN ??= TEST_CLOUDFLARE_TOKEN;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: wranglerPath },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
          CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_TOKEN,
          // The suite starts from the primary account alone; the account
          // tests add accounts themselves.
          CLOUDFLARE_ENDPOINT_ACCOUNTS: "",
          TEST_PRODUCTION_ENDPOINT_ACCOUNTS: JSON.stringify(productionAccounts),
          ALLOWED_ORIGINS: "https://app.openmausbot.test",
          // Production starts in observe (wrangler.jsonc); the suite exercises reclaiming.
          OMB_TUNNEL_RECLAIM: "on",
          // The tunnel release switches as the code defaults them (off), whatever wrangler.jsonc has live; the
          // release and cutoff tests turn each one on themselves.
          RELAY_TUNNEL_RELEASE_PERCENT: "0",
          RELAY_TUNNEL_RELEASE_DAYS: "3",
          TUNNEL_LEGACY_PHONE_CUTOFF_PERCENT: "0",
          TUNNEL_MIN_APP_VERSION: "",
          TUNNEL_REASON_MIN_VERSION: "",
          TEST_MIGRATIONS: await readD1Migrations(`${root}migrations`),
        },
        // An empty database for migration tests that need data written by an
        // older schema before the next migration runs.
        d1Databases: ["MIGRATION_DB"],
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
