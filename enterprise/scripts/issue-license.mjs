#!/usr/bin/env node
// Issue OpenMausBot enterprise license keys.
//
//   node enterprise/scripts/issue-license.mjs keygen [--out ~/.config/openmausbot-enterprise/signing-key.json]
//     Creates an Ed25519 signing key (file mode 0600) and prints the public
//     part to append to LICENSE_PUBLIC_KEYS in enterprise/server/license.ts.
//
//   node enterprise/scripts/issue-license.mjs issue --customer "Acme" --features whitelabel,sso \
//        [--expires 2027-09-02] [--issued 2026-09-02] [--seats 20] [--plan business-server] \
//        [--sub <subscription id>] [--server <server id>] [--iat <epoch ms>] [--key <path>]
//     Prints a key for OMB_LICENSE_KEY or the server's <data>/license.key. Claims are visible to the customer
//     (base64url JSON); only the signature is secret-derived. --issued defaults to today; --seats, --plan, --sub,
//     --server and --iat (the issue time in epoch ms, which orders two keys issued the same day) are optional claims
//     that servers from before them ignore. Ed25519 signing is deterministic, so
//     the same claims and key always print the same licence: another issuer can be checked against this one.
//
// The private key never enters the repo, a chat, or a container image.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { issueLicenseKey } from "../server/license.ts";

const DEFAULT_KEY_PATH = join(homedir(), ".config", "openmausbot-enterprise", "signing-key.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${arg.slice(2)} needs a value`);
    out[arg.slice(2)] = value;
    i += 1;
  }
  return out;
}

const [command, ...rest] = process.argv.slice(2);
const opts = flags(rest);

if (command === "keygen") {
  const out = opts.out ?? DEFAULT_KEY_PATH;
  if (existsSync(out)) fail(`${out} already exists; move it away first (a lost key means reissuing every customer)`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  // created owner-only in one step: no window where a 0666 file holds the key
  writeFileSync(out, JSON.stringify(privateKey.export({ format: "jwk" }), null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`signing key written to ${out} (keep it out of the repo; back it up)`);
  console.log(`append this to LICENSE_PUBLIC_KEYS in enterprise/server/license.ts:\n  "${publicKey.export({ format: "jwk" }).x}",`);
} else if (command === "issue") {
  const keyPath = opts.key ?? DEFAULT_KEY_PATH;
  if (!existsSync(keyPath)) fail(`no signing key at ${keyPath}; run "keygen" first or pass --key`);
  if (!opts.customer) fail("--customer is required (who the license is for)");
  if (!opts.features) fail("--features is required (comma-separated entitlement ids, e.g. whitelabel,sso)");
  let seats;
  if (opts.seats !== undefined) {
    seats = Number(opts.seats);
    if (!/^[0-9]+$/.test(opts.seats) || !Number.isSafeInteger(seats) || seats < 1) fail("--seats must be a whole number of at least 1");
  }
  let iat;
  if (opts.iat !== undefined) {
    iat = Number(opts.iat);
    if (!/^[0-9]+$/.test(opts.iat) || !Number.isSafeInteger(iat)) fail("--iat must be a time in epoch milliseconds");
  }
  const privateJwk = JSON.parse(readFileSync(keyPath, "utf8"));
  let key;
  try {
    key = issueLicenseKey(
      {
        v: 1,
        customer: opts.customer,
        features: opts.features.split(",").map((f) => f.trim()).filter(Boolean),
        issued: opts.issued ?? new Date().toISOString().slice(0, 10),
        expires: opts.expires ?? null,
        ...(seats !== undefined ? { seats } : {}),
        ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
        ...(opts.sub !== undefined ? { sub: opts.sub } : {}),
        ...(opts.server !== undefined ? { server: opts.server } : {}),
        ...(iat !== undefined ? { iat } : {}),
      },
      privateJwk,
    );
  } catch (error) {
    fail(`refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(key);
} else {
  fail('usage: issue-license.mjs keygen [--out path] | issue --customer "Name" --features a,b [--expires YYYY-MM-DD] [--issued YYYY-MM-DD] [--seats N] [--plan name] [--sub id] [--server id] [--iat ms] [--key path]');
}
