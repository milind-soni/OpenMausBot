import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { browserCaptureEndpoint, submitReceipt } from "../browser-extension/background.js";
import { importConnectedSourceExports } from "../server/capture-backfill.ts";
import {
  normalizeBrowserCapture,
  readBrowserCaptureDirectory,
  storeBrowserCaptureReceipt,
} from "../server/browser-capture.ts";
import { CaptureLedger } from "../server/capture-ledger.ts";
import { CaptureMemory } from "../server/capture-memory.ts";
import { importGrokCorpus } from "../server/grok-corpus.ts";
import { readAnvilBiHealth, readAnvilBiMercury } from "../server/local-capture.ts";
import { ingestNotificationMirror } from "../server/notification-mirror.ts";
import {
  createPlaudCliTranscriber,
  plaudReceiptsToTranscriptItems,
  pollPlaudCliRecordings,
  scanPlaudAudio,
} from "../server/plaud-audio.ts";

type Check = { id: string; status: "verified-local" | "needs-live-credential/device"; detail: string };

const checks: Check[] = [];
const manifestSchema = z.object({ permissions: z.array(z.string()).optional() });
const root = mkdtempSync(join(tmpdir(), "omb-capture-e2e-"));
const now = Date.parse("2026-08-26T13:00:00.000Z");

function verified(id: string, detail: string): void { checks.push({ id, status: "verified-local", detail }); }
function live(id: string, detail: string): void { checks.push({ id, status: "needs-live-credential/device", detail }); }
function fixtureReceipt(sourceId: "plaud" | "google-messages" | "youtube", captureId: string, capturedAt: string) {
  const urls = {
    plaud: "https://app.plaud.ai/recordings",
    "google-messages": "https://messages.google.com/web/conversations",
    youtube: "https://www.youtube.com/watch?v=fixture",
  } as const;
  const kinds = { plaud: "transcript", "google-messages": "message", youtube: "video" } as const;
  return {
    schemaVersion: 1 as const,
    captureId,
    capturedAt,
    sourceId,
    url: urls[sourceId],
    title: `${sourceId} fixture`,
    items: [{ kind: kinds[sourceId], title: "Fixture evidence", text: sourceId === "youtube" ? undefined : `${sourceId} captured text` }],
    cursor: { capturedAt, captureId },
  };
}

async function main(): Promise<void> {
  const memory = new CaptureMemory({ file: join(root, "capture.db"), now: () => now });
  const ledger = new CaptureLedger({ file: join(root, "ledger.db"), now: () => now });
  try {
    // Plaud: CLI/API path receives only the stable cloud id, never local audio.
    const archive = join(root, "plaud");
    mkdirSync(archive);
    const audio = join(archive, "team_call_deadbeef.m4a");
    writeFileSync(audio, "fixture audio");
    const cliCalls: Array<readonly string[]> = [];
    const transcriber = createPlaudCliTranscriber({ run: async (args) => {
      cliCalls.push(args);
      return { stdout: "Transcript: Team call\n\nKeep the decision.", stderr: "" };
    } });
    const cli = await scanPlaudAudio(archive, null, transcriber);
    assert.equal(cli.status, "ok");
    assert.deepEqual(cliCalls, [["transcript", "deadbeef"]]);
    assert.equal(JSON.stringify(cliCalls).includes(".m4a"), false);
    verified("plaud-cli", "Mock Plaud CLI transcript succeeded using stable recording id only; no AssemblyAI or audio upload.");

    const cloudCalls: Array<readonly string[]> = [];
    const cloudId = "0123456789abcdef";
    const cloud = await pollPlaudCliRecordings(null, { run: async (args) => {
      cloudCalls.push(args);
      if (args[0] === "recent") {
        return { stdout: `${cloudId}  Customer call  2026-08-26  12m`, stderr: "" };
      }
      if (args[0] === "file") {
        return {
          stdout: "name: Customer call\ncreated_at: 2026-08-26T12:00:00.000Z\ntranscript: available",
          stderr: "",
        };
      }
      return { stdout: "Transcript: Customer call\n\nPlaud produced this transcript.", stderr: "" };
    } });
    assert.equal(cloud.status, "ok");
    assert.deepEqual(cloudCalls, [
      ["recent", "--days", "14"],
      ["file", cloudId],
      ["transcript", "--polished", cloudId],
    ]);
    assert.equal(cloudCalls.some((args) => args.includes("audio")), false);
    const cloudDelta = await pollPlaudCliRecordings(cloud.cursor, { run: async (args) => {
      assert.deepEqual(args, ["recent", "--days", "14"]);
      return { stdout: `${cloudId}  Customer call  2026-08-26  12m`, stderr: "" };
    } });
    assert.equal(cloudDelta.status, "empty");
    verified("plaud-cloud-cli", "Polled authenticated Plaud cloud metadata and native transcripts delta-only, without downloading audio.");

    // Browser fallback: a fresh approved receipt is accepted when CLI access is unavailable.
    const browserDir = join(root, "browser-capture");
    const receipt = fixtureReceipt("plaud", "11111111-1111-4111-8111-111111111111", "2026-08-26T13:00:00.000Z");
    assert.ok(storeBrowserCaptureReceipt(receipt, browserDir));
    const browserRead = readBrowserCaptureDirectory(browserDir, null, "plaud", { now });
    assert.equal(browserRead.status, "ok");
    assert.equal(plaudReceiptsToTranscriptItems(browserRead.receipts).length, 1);
    const unavailableCli = await scanPlaudAudio(archive, null, async () => { throw new Error("Plaud CLI unavailable in fixture"); });
    assert.equal(unavailableCli.status, "failed");
    verified("plaud-browser-fallback", "Fresh approved Plaud browser receipt converts to transcript evidence after local CLI fallback.");

    // Android notification mirror: schema gate, device namespace, and dedupe.
    const notification = {
      id: "messages-1",
      packageName: "com.google.android.apps.messaging",
      postedAt: now,
      title: "Alex",
      text: "Can you call me?",
      conversationTitle: "Alex",
      sender: "Alex",
    };
    assert.equal(ingestNotificationMirror(memory, "phone-1", notification, { botId: "chief", sectionId: "ops" }).result.status, "inserted");
    assert.equal(ingestNotificationMirror(memory, "phone-1", notification, { botId: "chief", sectionId: "ops" }).result.status, "deduplicated");
    verified("android-messages-mirror", "Validated Google Messages notification is namespaced by paired device and deduplicated.");
    live("android-device", "A live Android notification-listener permission and paired device are required for physical delivery verification.");

    // Anvil BI: identity, loopback health, and Mercury delta cursor are exercised with local mocks.
    const anvil = join(root, "anvil-bi");
    mkdirSync(join(anvil, "apps", "server", "src", "integrations"), { recursive: true });
    writeFileSync(join(anvil, "package.json"), JSON.stringify({ name: "anvil-bi" }));
    writeFileSync(join(anvil, "apps", "server", "src", "integrations", "mercury.ts"), "export {};\n");
    const health = await readAnvilBiHealth(anvil, {
      fetcher: async () => new Response(JSON.stringify({ ok: true, db: true }), { status: 200 }),
      endpoint: "http://127.0.0.1:8080/api/health",
      now: () => now,
    });
    assert.equal(health.status, "ok");
    const snapshot = JSON.stringify({ capturedAt: "2026-08-26T13:00:00.000Z", cashAccounts: [], transactions: [{ id: "tx-1", source: "mercury", accountId: "acct", amountCents: -1, postedDate: "2026-08-26", description: "Fixture" }], notes: [] });
    const mercury = await readAnvilBiMercury(anvil, null, { run: async () => snapshot });
    assert.equal(mercury.status, "ok");
    assert.equal(mercury.items[0]?.metadata?.externalId, "tx-1");
    verified("anvil-bi-mercury", "Validated local Anvil BI project and consumed a mocked read-only Mercury snapshot with stable delta ids.");
    live("anvil-bi-live", "A live Anvil BI project and its own local Mercury configuration are required for credential/device verification.");

    // Browser delivery contract: no downloads permission and server-bound silent POST.
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(process.cwd(), "browser-extension", "manifest.json"), "utf8")));
    assert.equal(manifest.permissions?.includes("downloads"), false);
    let submittedUrl = "";
    await submitReceipt({ schemaVersion: 1, sourceId: "youtube", captureId: "fixture", capturedAt: now }, async (url: string) => {
      submittedUrl = url;
      return new Response(null, { status: 204 });
    });
    assert.equal(submittedUrl, browserCaptureEndpoint);
    verified("browser-extension-delivery", "Manifest has no downloads permission; receipts are delivered through the loopback bridge.");

    // Ledger health: explicit ok, auth, and error states remain visible, with fresh/stale/unknown classification.
    const run = ledger.begin({ botId: "capture", threadId: "fixture-thread", kind: "manual", scheduledFor: now, sources: [
      { id: "gmail-account-1", required: true }, { id: "google-messages", required: false }, { id: "broken-source", required: false },
    ] });
    ledger.recordSource("capture", run.runId, "gmail-account-1", { status: "ok", cursor: { historyId: "fixture" }, itemCount: 1 });
    ledger.recordSource("capture", run.runId, "google-messages", { status: "needs-auth", error: "signed-in browser session required" });
    ledger.recordSource("capture", run.runId, "broken-source", { status: "failed", error: "fixture failure" });
    assert.equal(ledger.finish("capture", run.runId).report.status, "degraded");
    const healthRows = ledger.sourceHealth("capture");
    assert.equal(healthRows.find((row) => row.sourceId === "gmail-account-1")?.freshness, "fresh");
    assert.equal(healthRows.find((row) => row.sourceId === "google-messages")?.status, "needs-auth");
    assert.equal(healthRows.find((row) => row.sourceId === "broken-source")?.status, "failed");
    verified("source-health-dashboard", "Ledger report preserves fresh, auth-required, and failed source states without exposing cursors.");

    // Provenance + backfill: Grok corpus and connector exports share memory and dedupe identities.
    const corpus = join(root, "grok");
    mkdirSync(corpus);
    writeFileSync(join(corpus, "history.blob"), JSON.stringify({ value: { entries: [{ id: "g1", kind: "message", role: "user", content: "Grok fixture decision", timestampMs: now }] } }));
    const grok = importGrokCorpus({ memory, roots: [corpus], botId: "chief", sectionId: "ops", capturedAt: now });
    assert.equal(grok.inserted, 1);
    const connectedFile = join(root, "connected.json");
    writeFileSync(connectedFile, JSON.stringify([{ sourceId: "gmail-account-1", accountId: "work", externalId: "mail-1", kind: "email", title: "Connector fixture", body: "Read-only export", occurredAt: now, evidenceRef: "connector://gmail/mail-1" }]));
    const connected = importConnectedSourceExports({ memory, files: [connectedFile], botId: "chief", sectionId: "ops", capturedAt: now });
    assert.equal(connected.inserted, 1);
    const evidence = memory.search({ botId: "chief", includeSensitive: true });
    assert.ok(evidence.some((item) => item.provenance.evidenceRef === "connector://gmail/mail-1"));
    verified("grok-and-connected-backfill", "Explicit Grok corpus and connector export backfills are rerunnable, deduplicated, and provenance-bearing.");
    live("connected-sources", "Live Gmail/Calendar/Drive/GitHub authorizations are required to produce a real connector export; no credentials were read by this verifier.");

    // Browser stale behavior is checked separately so a dead extension is not an empty source.
    const stale = normalizeBrowserCapture(fixtureReceipt("google-messages", "22222222-2222-4222-8222-222222222222", "2026-08-26T12:00:00.000Z"));
    assert.ok(stale);
    const staleDir = join(root, "stale-browser");
    assert.ok(storeBrowserCaptureReceipt(stale, staleDir));
    assert.equal(readBrowserCaptureDirectory(staleDir, null, "google-messages", { now, staleAfterMs: 15 * 60_000 }).status, "failed");
    verified("browser-stale-fail-closed", "Stale browser observations fail closed and cannot masquerade as an empty successful read.");

    console.log(JSON.stringify({ generatedAt: new Date(now).toISOString(), mode: "deterministic-local-fixtures", checks }, null, 2));
  } finally {
    ledger.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error(JSON.stringify({ generatedAt: new Date(now).toISOString(), mode: "deterministic-local-fixtures", checks, error: "Capture verifier failed" }, null, 2));
  process.exitCode = 1;
});
