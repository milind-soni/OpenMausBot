#!/usr/bin/env -S node --experimental-strip-types
// Operations entry for the OpenConnector provider's per-app OAuth configuration — the piece the
// product UI does not cover yet. An operator with the admin token configures an app's OAuth client
// on the runtime (where the secret lives) and reads the configuration back. The client secret is
// read from OPENCONNECTOR_OAUTH_CLIENT_SECRET so it never appears in argv or shell history. Usage:
//   node scripts/openconnector-oauth.ts configure <service> --client-id <id> [--scope <scope> ...]
//   node scripts/openconnector-oauth.ts status <service>
// Connection selection comes from the same env/config as the server: OMB_CONNECTOR_PROVIDER,
// OMB_OPENCONNECTOR_URL, OMB_OPENCONNECTOR_ADMIN_TOKEN (or OMB_OPENCONNECTOR_ADMIN_TOKEN_REF).
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  CONNECTOR_PROVIDER_ENV,
  OPENCONNECTOR_ADMIN_TOKEN_ENV,
  OPENCONNECTOR_ADMIN_TOKEN_REF_ENV,
  OPENCONNECTOR_URL_ENV,
  loadConnectorSettings,
  assertOpenConnectorSettings,
  resolveTokenRef,
} from "../server/connectors/provider.ts";
import { OpenConnectorClient, normalizeOpenConnectorBaseUrl } from "../server/connectors/openconnector/client.ts";
import { OPENCONNECTOR_STATE_FILE, OpenConnectorStateStore } from "../server/connectors/openconnector/state.ts";
import { DATA_DIR } from "../server/config.ts";
import { appOAuthStatus, configureAppOAuth } from "../server/connectors/openconnector/oauth.ts";

const USAGE = `Usage:
  node scripts/openconnector-oauth.ts configure <service> --client-id <id> [--scope <scope> ...]
  node scripts/openconnector-oauth.ts status <service>

Settings come from ${CONNECTOR_PROVIDER_ENV}=openconnector, ${OPENCONNECTOR_URL_ENV},
${OPENCONNECTOR_ADMIN_TOKEN_ENV} (or ${OPENCONNECTOR_ADMIN_TOKEN_REF_ENV}=env:VAR|file:PATH).
The client secret comes from OPENCONNECTOR_OAUTH_CLIENT_SECRET (for example, a shell read -s prompt).`;

function fail(message: string): never {
  console.error(`openconnector-oauth: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "client-id": { type: "string" },
    scope: { type: "string", multiple: true },
  },
});

const [verb, service] = positionals;
if (!verb || !service) fail("a verb (configure|status) and a service are required");

const settings = loadConnectorSettings();
if (settings.provider !== "openconnector") {
  fail(`${CONNECTOR_PROVIDER_ENV} is "${settings.provider}", not "openconnector"`);
}
if (!settings.openconnector.url) fail(`${OPENCONNECTOR_URL_ENV} is not set`);
const adminToken = resolveTokenRef(settings.openconnector.adminTokenRef) ?? process.env[OPENCONNECTOR_ADMIN_TOKEN_ENV];
if (!adminToken) fail(`no admin token: set ${OPENCONNECTOR_ADMIN_TOKEN_ENV} or ${OPENCONNECTOR_ADMIN_TOKEN_REF_ENV}`);
assertOpenConnectorSettings(settings);

const client = new OpenConnectorClient({ baseUrl: settings.openconnector.url, adminToken });
const state = new OpenConnectorStateStore(join(DATA_DIR, OPENCONNECTOR_STATE_FILE), normalizeOpenConnectorBaseUrl(settings.openconnector.url));

if (verb === "configure") {
  const clientId = values["client-id"];
  if (!clientId) fail("configure needs --client-id");
  const clientSecret = process.env.OPENCONNECTOR_OAUTH_CLIENT_SECRET;
  if (!clientSecret) fail("configure needs OPENCONNECTOR_OAUTH_CLIENT_SECRET");
  const { expectedRedirectUri } = await configureAppOAuth(client, state, service, {
    clientId,
    clientSecret,
    scopes: values.scope ?? [],
  });
  console.log(JSON.stringify({ service, configured: true, expectedRedirectUri: expectedRedirectUri ?? null }));
} else if (verb === "status") {
  const status = await appOAuthStatus(client, state, service);
  console.log(JSON.stringify({
    service,
    configured: status.configured,
    expectedRedirectUri: status.expectedRedirectUri ?? null,
    clientId: status.clientId ?? null,
    scopes: status.scopes ?? [],
  }));
} else {
  fail(`unknown verb "${verb}"`);
}
