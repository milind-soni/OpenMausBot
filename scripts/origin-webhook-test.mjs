#!/usr/bin/env node
/**
 * Sends a sample Origin issue webhook, signed like the real ones, to check a receiver without a live workspace.
 *
 *   ORIGIN_ISSUE_WEBHOOK_SECRET='…' node scripts/origin-webhook-test.mjs --url http://127.0.0.1:8787/hook
 *   ORIGIN_ISSUE_WEBHOOK_SECRET='…' node scripts/origin-webhook-test.mjs --url http://127.0.0.1:8787/hook --event issue.updated
 *
 * The secret (at least 32 characters) signs the body: X-Origin-Signature is `sha256=` plus the hex HMAC-SHA256 of the
 * raw body. Prints the payload and the HTTP status; never the secret. Needs Node 24 (it imports the TypeScript module
 * the server uses, lib/issue-webhook.ts).
 */
import { parseArgs } from "node:util";
import { ISSUE_WEBHOOK_MIN_SECRET, issueWebhookRequest, postIssueWebhook, sampleIssueWebhookPayload } from "../lib/issue-webhook.ts";

const { values } = parseArgs({ options: { url: { type: "string" }, event: { type: "string", default: "issue.created" } } });
const secret = process.env.ORIGIN_ISSUE_WEBHOOK_SECRET ?? "";
const fail = message => { console.error(message); process.exit(1); };

if (!values.url) fail("Usage: ORIGIN_ISSUE_WEBHOOK_SECRET='…' node scripts/origin-webhook-test.mjs --url <url> [--event issue.created|issue.updated|issue.delegated]");
if (!["issue.created", "issue.updated", "issue.delegated"].includes(values.event)) fail("--event is issue.created, issue.updated or issue.delegated");
if (secret.length < ISSUE_WEBHOOK_MIN_SECRET) fail(`Set ORIGIN_ISSUE_WEBHOOK_SECRET to at least ${ISSUE_WEBHOOK_MIN_SECRET} characters`);

const payload = sampleIssueWebhookPayload(values.event, process.env.ORIGIN_PUBLIC_URL);
const request = await issueWebhookRequest(payload, secret);
console.log(JSON.stringify(payload, null, 2));
console.log(`X-Origin-Event: ${request.headers["X-Origin-Event"]}\nX-Origin-Delivery: ${request.headers["X-Origin-Delivery"]}\nX-Origin-Signature: ${request.headers["X-Origin-Signature"]}`);
try {
  const status = await postIssueWebhook(values.url, request);
  console.log(`HTTP ${status}`);
  process.exitCode = status >= 200 && status < 300 ? 0 : 1;
} catch (error) {
  fail(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
}
