import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MAX_ENDPOINT_ACCOUNTS, readConfig, type ControlPlaneConfig, type EndpointAccount } from "../src/config";
import {
  accountRoom,
  ACTED_ON_ENDPOINT_SQL,
  actedOnAccounts,
  appVersionAtLeast,
  chooseNewEndpointAccount,
  emptySnapshot,
  endpointAccountFor,
  neverReady,
  opaqueHostnameSQL,
  relocationTarget,
  type AccountSnapshot,
} from "../src/endpoint-accounts";

const TOKEN_SECRET = "CLOUDFLARE_API_TOKEN_MAUSBOT_SI";
const TOKEN = "test-only-mausbot-si-api-token-with-no-real-access";
const SECOND_ENTRY = {
  accountId: "2B".repeat(16),
  zoneId: "3c".repeat(16),
  companionHostSuffix: "mausbot.si",
  apiTokenSecret: TOKEN_SECRET,
};

function withAccounts(value: unknown, secrets: Record<string, string> = { [TOKEN_SECRET]: TOKEN }): Env {
  return { ...env, CLOUDFLARE_ENDPOINT_ACCOUNTS: value, ...secrets } as unknown as Env;
}

describe("endpoint account configuration", () => {
  it("is the primary account alone unless CLOUDFLARE_ENDPOINT_ACCOUNTS adds more", () => {
    const config = readConfig(env);
    expect(config.cloudflare).toEqual({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      companionHostSuffix: env.COMPANION_HOST_SUFFIX,
      dnsRecordLimit: 1000,
      minAppVersion: null,
      newEndpoints: true,
      tunnelLimit: 1000,
      zoneId: env.CLOUDFLARE_ZONE_ID,
    });
    expect(config.endpointAccounts).toEqual([config.cloudflare]);
    expect(config.endpointAccountIssues).toEqual([]);
    for (const unset of [undefined, null, ""]) {
      expect(readConfig(withAccounts(unset)).endpointAccounts).toEqual([config.cloudflare]);
    }
  });

  it("reads extra accounts from a JSON var, or the same JSON as a string or secret", () => {
    const entry = { ...SECOND_ENTRY, tunnelLimit: 1000, dnsRecordLimit: 200, minAppVersion: "0.1.103" };
    for (const value of [[entry], JSON.stringify([entry])]) {
      const config = readConfig(withAccounts(value));
      expect(config.endpointAccountIssues).toEqual([]);
      expect(config.endpointAccounts).toEqual([config.cloudflare, {
        accountId: "2b".repeat(16),
        apiToken: TOKEN,
        companionHostSuffix: "mausbot.si",
        dnsRecordLimit: 200,
        minAppVersion: "0.1.103",
        newEndpoints: true,
        tunnelLimit: 1000,
        zoneId: "3c".repeat(16),
      }]);
    }
    // Quotas default to Cloudflare's, there is no version floor, and one
    // token may serve both accounts.
    const shared = readConfig(withAccounts([{ ...SECOND_ENTRY, apiTokenSecret: "CLOUDFLARE_API_TOKEN" }], {}));
    expect(shared.endpointAccounts[1]).toMatchObject({
      apiToken: env.CLOUDFLARE_API_TOKEN,
      dnsRecordLimit: 1000,
      minAppVersion: null,
      newEndpoints: true,
      tunnelLimit: 1000,
    });
    // Closed to new endpoints, keeping the ones it holds.
    const closed = readConfig(withAccounts([{ ...SECOND_ENTRY, newEndpoints: false }]));
    expect(closed.endpointAccountIssues).toEqual([]);
    expect(closed.endpointAccounts[1]).toMatchObject({ companionHostSuffix: "mausbot.si", newEndpoints: false });
  });

  it("drops a bad entry with a redacted issue code and never throws", () => {
    const extra = (index: number) => ({
      accountId: `${index}`.repeat(32),
      zoneId: `${index}a`.repeat(16),
      companionHostSuffix: `extra${index}.example`,
      apiTokenSecret: TOKEN_SECRET,
    });
    const cases: Array<{ accounts: number; issues: string[]; secrets?: Record<string, string>; value: unknown }> = [
      { value: "[{", accounts: 1, issues: ["accounts_json"] },
      { value: SECOND_ENTRY, accounts: 1, issues: ["accounts_json"] },
      { value: [{ ...SECOND_ENTRY, accountId: env.CLOUDFLARE_ACCOUNT_ID.toUpperCase() }], accounts: 1, issues: ["entry_1_duplicate"] },
      { value: [{ ...SECOND_ENTRY, zoneId: env.CLOUDFLARE_ZONE_ID }], accounts: 1, issues: ["entry_1_duplicate"] },
      { value: [{ ...SECOND_ENTRY, companionHostSuffix: env.COMPANION_HOST_SUFFIX }], accounts: 1, issues: ["entry_1_duplicate"] },
      { value: [SECOND_ENTRY, SECOND_ENTRY], accounts: 2, issues: ["entry_2_duplicate"] },
      // Only a Cloudflare token's name: never another secret.
      { value: [{ ...SECOND_ENTRY, apiTokenSecret: "BETTER_AUTH_SECRET" }], accounts: 1, issues: ["entry_1_shape"] },
      { value: [SECOND_ENTRY], secrets: {}, accounts: 1, issues: ["entry_1_token"] },
      { value: [SECOND_ENTRY], secrets: { [TOKEN_SECRET]: "short" }, accounts: 1, issues: ["entry_1_token"] },
      { value: [{ ...SECOND_ENTRY, companionHostSuffix: "Mausbot.si" }], accounts: 1, issues: ["entry_1_suffix"] },
      { value: [{ ...SECOND_ENTRY, companionHostSuffix: "si" }], accounts: 1, issues: ["entry_1_suffix"] },
      { value: [{ ...SECOND_ENTRY, accountId: "not-an-account" }], accounts: 1, issues: ["entry_1_shape"] },
      { value: [{ ...SECOND_ENTRY, minAppVersion: "0.1" }], accounts: 1, issues: ["entry_1_shape"] },
      { value: [{ ...SECOND_ENTRY, tunnelLimit: 0 }], accounts: 1, issues: ["entry_1_shape"] },
      { value: [{ ...SECOND_ENTRY, tunnelLimit: "1000" }], accounts: 1, issues: ["entry_1_shape"] },
      { value: [{ ...SECOND_ENTRY, newEndpoints: "false" }], accounts: 1, issues: ["entry_1_shape"] },
      { value: [{ ...SECOND_ENTRY, accountID: SECOND_ENTRY.accountId }], accounts: 1, issues: ["entry_1_shape"] },
      { value: [1, 2, 3, 4].map(extra), accounts: MAX_ENDPOINT_ACCOUNTS, issues: ["entry_4_over_limit"] },
    ];
    for (const { accounts, issues, secrets, value } of cases) {
      const config = readConfig(withAccounts(value, secrets));
      expect(config.endpointAccountIssues, JSON.stringify(value)).toEqual(issues);
      expect(config.endpointAccounts, JSON.stringify(value)).toHaveLength(accounts);
      expect(config.endpointAccounts[0]).toBe(config.cloudflare);
      expect(config.endpointAccounts.some((account) => account.apiToken === env.BETTER_AUTH_SECRET)).toBe(false);
    }
  });
});

const PRIMARY: EndpointAccount = {
  accountId: "0c92969a82eb9e173b013a7e7a02333d",
  apiToken: "primary-token-for-pure-tests-only",
  companionHostSuffix: "openmausbot.com",
  dnsRecordLimit: 1000,
  minAppVersion: null,
  newEndpoints: true,
  tunnelLimit: 1000,
  zoneId: "a".repeat(32),
};
const SECOND: EndpointAccount = {
  accountId: "2b".repeat(16),
  apiToken: "second-token-for-pure-tests-only",
  companionHostSuffix: "mausbot.si",
  dnsRecordLimit: 200,
  minAppVersion: null,
  newEndpoints: true,
  tunnelLimit: 1000,
  zoneId: "b".repeat(32),
};
const NOW = 1_800_000_000_000;

function accounts(...list: EndpointAccount[]): ControlPlaneConfig {
  return { cloudflare: list[0], endpointAccounts: list } as unknown as ControlPlaneConfig;
}

function scanned(account: EndpointAccount, fields: Partial<AccountSnapshot> = {}): [string, AccountSnapshot] {
  return [account.accountId, { ...emptySnapshot(account.accountId), checked_at: NOW - 60_000, ...fields }];
}

describe("endpoint account rules", () => {
  it("compares app versions as numeric releases", () => {
    for (const version of ["0.1.103", "0.1.104", "0.2.0", "1.0.0", "0.1.103+build.7"]) {
      expect(appVersionAtLeast(version, "0.1.103"), version).toBe(true);
    }
    for (const version of ["0.1.102", "0.1.99", "0.0.999", "0.1.103-beta.1", "unknown", "", null, undefined, "v0.1.103", "0.1", "0.1.103.1", " 0.1.103"]) {
      expect(appVersionAtLeast(version, "0.1.103"), String(version)).toBe(false);
    }
    expect(appVersionAtLeast("0.10.0", "0.9.1")).toBe(true);
  });

  it("chooses the account with the most room after its dormant endpoints, and never refuses", () => {
    const config = accounts(PRIMARY, SECOND);
    // 5 tunnels free but 20 owed to dormant endpoints, against 100 free.
    const owed = new Map([scanned(PRIMARY, { dormant_endpoints: 20, tunnel_count: 995 }), scanned(SECOND, { tunnel_count: 900 })]);
    expect(accountRoom(PRIMARY, owed.get(PRIMARY.accountId))).toBe(-15);
    expect(chooseNewEndpointAccount(config, owed, null, NOW)).toBe(SECOND);
    // The zone's DNS quota counts when it is known: 200 - 150 records.
    const dns = new Map([scanned(PRIMARY, { tunnel_count: 900 }), scanned(SECOND, { dns_record_count: 150, tunnel_count: 0 })]);
    expect(accountRoom(SECOND, dns.get(SECOND.accountId))).toBe(50);
    expect(chooseNewEndpointAccount(config, dns, null, NOW)).toBe(PRIMARY);
    // Ties keep config order; an unknown tunnel count ranks last.
    const tie = new Map([scanned(PRIMARY, { tunnel_count: 900 }), scanned(SECOND, { tunnel_count: 900 })]);
    expect(chooseNewEndpointAccount(config, tie, null, NOW)).toBe(PRIMARY);
    const unknown = new Map([scanned(PRIMARY, { tunnel_count: null }), scanned(SECOND, { tunnel_count: 999 })]);
    expect(chooseNewEndpointAccount(config, unknown, null, NOW)).toBe(SECOND);
    // Room only ranks: with none anywhere the better account is still tried.
    const full = new Map([scanned(PRIMARY, { tunnel_count: 1002 }), scanned(SECOND, { tunnel_count: 1001 })]);
    expect(chooseNewEndpointAccount(config, full, null, NOW)).toBe(SECOND);
  });

  it("offers only scanned accounts that are not refusing and allow the app's version", () => {
    const gated = { ...SECOND, minAppVersion: "0.1.103" };
    const config = accounts(PRIMARY, gated);
    const room = (fields: Partial<AccountSnapshot> = {}) => new Map([
      scanned(PRIMARY, { tunnel_count: 990 }),
      scanned(gated, { tunnel_count: 0, ...fields }),
    ]);
    expect(chooseNewEndpointAccount(config, room(), "0.1.103", NOW)).toBe(gated);
    expect(chooseNewEndpointAccount(config, room(), "0.1.102", NOW)).toBe(PRIMARY);
    expect(chooseNewEndpointAccount(config, room(), null, NOW)).toBe(PRIMARY);
    // Never scanned, or not for over 30 minutes.
    expect(chooseNewEndpointAccount(config, room({ checked_at: null }), "0.1.103", NOW)).toBe(PRIMARY);
    expect(chooseNewEndpointAccount(config, room({ checked_at: NOW - 31 * 60_000 }), "0.1.103", NOW)).toBe(PRIMARY);
    // Refused a resource in the last ten minutes, but not eleven minutes ago.
    expect(chooseNewEndpointAccount(config, room({ capacity_rejected_at: NOW - 60_000 }), "0.1.103", NOW)).toBe(PRIMARY);
    expect(chooseNewEndpointAccount(config, room({ capacity_rejected_at: NOW - 11 * 60_000 }), "0.1.103", NOW)).toBe(gated);
    // Nothing eligible at all: the primary, as with a single account.
    expect(chooseNewEndpointAccount(config, new Map(), "0.1.103", NOW)).toBe(PRIMARY);
  });

  it("never gives a closed account a new endpoint, nor moves one there", () => {
    const closed = { ...SECOND, newEndpoints: false };
    const snapshots = new Map([scanned(PRIMARY, { tunnel_count: 999 }), scanned(SECOND, { tunnel_count: 0 })]);
    expect(chooseNewEndpointAccount(accounts(PRIMARY, closed), snapshots, "0.1.104", NOW)).toBe(PRIMARY);
    expect(relocationTarget(accounts(PRIMARY, closed), snapshots, "0.1.104", PRIMARY, NOW)).toBeNull();
    // Open, the same account takes them.
    expect(chooseNewEndpointAccount(accounts(PRIMARY, SECOND), snapshots, "0.1.104", NOW)).toBe(SECOND);
    expect(relocationTarget(accounts(PRIMARY, SECOND), snapshots, "0.1.104", PRIMARY, NOW)).toBe(SECOND);
  });

  it("relocates only to another eligible account, with no fallback", () => {
    const config = accounts(PRIMARY, SECOND);
    const snapshots = new Map([scanned(PRIMARY, { tunnel_count: 10 }), scanned(SECOND, { tunnel_count: 10 })]);
    expect(relocationTarget(config, snapshots, null, PRIMARY, NOW)).toBe(SECOND);
    expect(relocationTarget(config, snapshots, null, SECOND, NOW)).toBe(PRIMARY);
    const refusing = new Map([scanned(PRIMARY), scanned(SECOND, { capacity_rejected_at: NOW, tunnel_count: 10 })]);
    expect(relocationTarget(config, refusing, null, PRIMARY, NOW)).toBeNull();
    expect(relocationTarget(accounts(PRIMARY), snapshots, null, PRIMARY, NOW)).toBeNull();
  });

  it("ties a row to its own configured account and that account's suffix only", () => {
    const config = accounts(PRIMARY, SECOND);
    const label = `c-${"0123456789abcdef".repeat(2)}`;
    expect(endpointAccountFor(config, { hostname: `${label}.mausbot.si`, provider_account: SECOND.accountId })).toBe(SECOND);
    expect(endpointAccountFor(config, { hostname: `${label}.openmausbot.com`, provider_account: PRIMARY.accountId })).toBe(PRIMARY);
    for (const [providerAccount, hostname] of [
      [SECOND.accountId, `${label}.openmausbot.com`],
      [PRIMARY.accountId, `${label}.mausbot.si`],
      ["9".repeat(32), `${label}.mausbot.si`],
      [SECOND.accountId, `www.${label}.mausbot.si`],
      [SECOND.accountId, `${label.toUpperCase()}.mausbot.si`],
      [SECOND.accountId, "c-abc.mausbot.si"],
      [SECOND.accountId, `${label}.evilmausbot.si`],
      [SECOND.accountId, "mausbot.si"],
    ]) {
      expect(endpointAccountFor(config, { hostname, provider_account: providerAccount }), hostname).toBeNull();
    }
  });

  it("states that rule identically in SQL, for the queries that pick or count rows", async () => {
    const config = accounts(PRIMARY, SECOND);
    const label = (index: number) => `c-${index.toString(16).padStart(32, "0")}`;
    const cases: Array<[string, string]> = [
      [SECOND.accountId, `${label(1)}.mausbot.si`],
      [PRIMARY.accountId, `${label(2)}.openmausbot.com`],
      [SECOND.accountId, `c-${"0123456789abcdef".repeat(2)}.mausbot.si`],
      [SECOND.accountId, `${label(3)}.openmausbot.com`],
      [PRIMARY.accountId, `${label(4)}.mausbot.si`],
      ["9".repeat(32), `${label(5)}.mausbot.si`],
      [SECOND.accountId, `www.${label(6)}.mausbot.si`],
      [SECOND.accountId, `${label(7).toUpperCase()}.mausbot.si`],
      [SECOND.accountId, `c-${"0123456789abcdeg".repeat(2)}.mausbot.si`],
      [SECOND.accountId, "c-abc.mausbot.si"],
      [SECOND.accountId, `${label(8)}0.mausbot.si`],
      [SECOND.accountId, `${label(9)}.evilmausbot.si`],
      [SECOND.accountId, `${label(10)}.mausbot.si.evil.test`],
      [SECOND.accountId, `${label(11)}.mausbot.si.`],
      [SECOND.accountId, `d-${"0".repeat(31)}c.mausbot.si`],
      [SECOND.accountId, `${label(12)}mausbot.si`],
      [SECOND.accountId, "mausbot.si"],
    ];
    const now = Date.now();
    await env.DB.batch(cases.map(([providerAccount, hostname], index) => env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, provider_account, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
    ).bind(`rule-${index}`, providerAccount, hostname, `rule-tunnel-${index}`, now, now)));
    const expected = cases.flatMap(([providerAccount, hostname], index) => (
      endpointAccountFor(config, { hostname, provider_account: providerAccount }) ? [`rule-${index}`] : []
    ));
    expect(expected).toEqual(["rule-0", "rule-1", "rule-2"]);

    const everyAccount = await env.DB.prepare(
      `SELECT e.installation_id FROM installation_endpoints e
        WHERE ${ACTED_ON_ENDPOINT_SQL} ORDER BY e.rowid`,
    ).bind(actedOnAccounts(config)).all<{ installation_id: string }>();
    expect(everyAccount.results.map((row) => row.installation_id)).toEqual(expected);
    for (const account of [PRIMARY, SECOND]) {
      const one = await env.DB.prepare(
        `SELECT installation_id FROM installation_endpoints
          WHERE provider_account = ? AND ${opaqueHostnameSQL("hostname", "?")} ORDER BY rowid`,
      ).bind(account.accountId, account.companionHostSuffix).all<{ installation_id: string }>();
      expect(one.results.map((row) => row.installation_id)).toEqual(cases.flatMap(([providerAccount, hostname], index) => (
        endpointAccountFor(config, { hostname, provider_account: providerAccount }) === account ? [`rule-${index}`] : []
      )));
    }
  });

  it("lets only a row that never handed out an address move", () => {
    const fresh = { dns_record_id: null, last_reconciled_at: null, tunnel_id: null };
    expect(neverReady(fresh)).toBe(true);
    expect(neverReady({ ...fresh, tunnel_id: "10000000-0000-4000-8000-000000000001" })).toBe(false);
    expect(neverReady({ ...fresh, dns_record_id: "dns-1" })).toBe(false);
    // Reclaimed or deleted after it was ready: its address is out there.
    expect(neverReady({ ...fresh, last_reconciled_at: NOW })).toBe(false);
  });
});
