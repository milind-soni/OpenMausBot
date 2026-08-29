import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  anvilChildEnvironment,
  localCaptureToLedgerItems,
  readAnvilBiHealth,
  readAnvilBiMercury,
  readChromeHistory,
  readHevyExport,
  readLocalInbox,
  readTelegramRelayHealth,
  readWhoopExport,
} from "./local-capture.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix)); directories.push(directory); return directory;
}

describe("local capture collectors", () => {
  it("reads Chrome history from a copy, emits domains/titles, and advances a tie-safe cursor", () => {
    const directory = temporaryDirectory("omb-history-");
    const history = join(directory, "History");
    const database = new DatabaseSync(history);
    database.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT, last_visit_time INTEGER NOT NULL)");
    database.prepare("INSERT INTO urls VALUES (?, ?, ?, ?), (?, ?, ?, ?)").run(
      1, "https://example.com/private?token=do-not-copy", "Example", 11_644_473_600_000_000n + 1_000_000n,
      2, "https://openai.com/docs", "OpenAI", 11_644_473_600_000_000n + 2_000_000n,
    );
    database.close();
    const first = readChromeHistory(history);
    expect(first.status).toBe("ok");
    expect(first.items.map((item) => item.metadata?.domain)).toEqual(["example.com", "openai.com"]);
    expect(first.items[0]?.title).toBe("Example");
    expect(first.items[0]?.evidenceRef).not.toContain("token");
    expect(readChromeHistory(history, first.cursor).status).toBe("empty");
  });

  it("reconciles an inbox, skips symlinks, bounds content, and catches changes", () => {
    const directory = temporaryDirectory("omb-inbox-");
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "nested", "note.md"), "hello\nverification code: 123456");
    writeFileSync(join(directory, "image.bin"), Buffer.alloc(8, 3));
    const outside = temporaryDirectory("omb-outside-");
    writeFileSync(join(outside, "secret.txt"), "outside");
    try { symlinkSync(join(outside, "secret.txt"), join(directory, "escape.txt")); } catch { /* symlinks can be disabled on Windows */ }
    const first = readLocalInbox(directory);
    expect(first.status).toBe("ok");
    expect(first.items.map((item) => item.title)).toContain("nested/note.md");
    expect(first.items.map((item) => item.title)).not.toContain("escape.txt");
    expect(first.items.find((item) => item.title.endsWith("note.md"))?.text).toContain("[redacted]");
    expect(readLocalInbox(directory, first.cursor).status).toBe("empty");
    writeFileSync(join(directory, "nested", "note.md"), "changed");
    utimesSync(join(directory, "nested", "note.md"), new Date(), new Date());
    expect(readLocalInbox(directory, first.cursor).items).toHaveLength(1);
  });

  it("reads WHOOP JSON and CSV exports while dropping credential-shaped fields", () => {
    const directory = temporaryDirectory("omb-whoop-");
    const json = join(directory, "sleep.json");
    writeFileSync(json, JSON.stringify([{ type: "sleep", score: 92, recovery: 87, access_token: "never emit" }]));
    const first = readWhoopExport(json);
    expect(first.status).toBe("ok");
    expect(first.items[0]?.title).toContain("sleep");
    expect(first.items[0]?.text).toContain("score: 92");
    expect(first.items[0]?.text).not.toContain("never emit");
    expect(localCaptureToLedgerItems(first.items)).toMatchObject([{ sourceId: "whoop", title: expect.any(String) }]);
    expect(readWhoopExport(json, first.cursor).status).toBe("empty");
    const csv = join(directory, "recovery.csv");
    writeFileSync(csv, "date,recovery,refresh_token\n2026-08-26,81,do-not-emit\n");
    const csvResult = readWhoopExport(csv);
    expect(csvResult.items[0]?.text).toContain("recovery: 81");
    expect(csvResult.items[0]?.text).not.toContain("do-not-emit");
  });

  it("redacts common provider credentials embedded in otherwise safe text fields", () => {
    const directory = temporaryDirectory("omb-secret-redaction-");
    const json = join(directory, "snapshot.json");
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const bearer = "Bearer abcdefghijklmnop1234";
    writeFileSync(json, JSON.stringify([{ type: "note", description: `authorization: ${bearer}`, detail: awsKey }]));
    const result = readWhoopExport(json);
    expect(result.items[0]?.text).toContain("[redacted]");
    expect(result.items[0]?.text).not.toContain(awsKey);
    expect(result.items[0]?.text).not.toContain(bearer);
  });

  it("keeps Hevy as an independent source while reusing the token-free export parser", () => {
    const directory = temporaryDirectory("omb-hevy-");
    const json = join(directory, "hevy.json");
    writeFileSync(json, JSON.stringify([{ workout_type: "strength", duration: 42, api_key: "never emit" }]));
    const result = readHevyExport(json);
    expect(result.status).toBe("ok");
    expect(result.items[0]?.sourceId).toBe("hevy");
    expect(result.items[0]?.text).toContain("duration: 42");
    expect(result.items[0]?.text).not.toContain("never emit");
  });

  it("validates Anvil BI identity before probing its loopback health endpoint", async () => {
    const directory = temporaryDirectory("omb-anvil-bi-");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "anvil-bi" }));
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: true, db: true }), { status: 200 });
    const result = await readAnvilBiHealth(directory, { endpoint: "http://127.0.0.1:8080/api/health", fetcher, now: () => 1_756_000_000_000 });
    expect(result.status).toBe("ok");
    expect(result.items[0]).toMatchObject({ sourceId: "anvil-bi", title: "Anvil BI health", metadata: { healthy: true, database: true } });
    const wrong = temporaryDirectory("omb-not-anvil-");
    writeFileSync(join(wrong, "package.json"), JSON.stringify({ name: "other" }));
    expect((await readAnvilBiHealth(wrong, { fetcher })).status).toBe("failed");
  });

  it("does not require Anvil's optional 8080 web server for the local adapter", async () => {
    const directory = temporaryDirectory("omb-anvil-adapter-");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "anvil-bi" }));
    let probes = 0;
    const fetcher: typeof fetch = async () => {
      probes += 1;
      throw new Error("the optional web server is intentionally offline");
    };
    const result = await readAnvilBiHealth(directory, { fetcher, now: () => 1_756_000_000_000 });
    expect(result).toMatchObject({ status: "ok", items: [{ evidenceRef: "anvil-bi://adapter" }] });
    expect(result.items[0]?.metadata).toEqual({ transport: "local-project", healthProbe: false });
    expect(probes).toBe(0);
  });

  it("does not pass OpenMaus workspace secrets into the Anvil helper", () => {
    expect(anvilChildEnvironment({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      OMB_OPENAI_API_KEY: "secret",
      CURSOR_API_KEY: "secret",
      MERCURY_API_KEY: "server-secret",
    })).toEqual({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
  });

  it("reads Mercury through Anvil BI once, then emits only account and transaction deltas", async () => {
    const directory = temporaryDirectory("omb-anvil-mercury-");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "anvil-bi" }));
    const adapterDirectory = join(directory, "apps", "server", "src", "integrations");
    mkdirSync(adapterDirectory, { recursive: true });
    writeFileSync(join(adapterDirectory, "mercury.ts"), "export {};\n");
    const firstSnapshot = {
      capturedAt: "2026-08-26T12:00:00.000Z",
      cashAccounts: [
        { id: "mercury_operating", source: "mercury", name: "Operating", balanceCents: 125_000, availableCents: 120_000 },
      ],
      transactions: [
        { id: "mercury_tx_1", source: "mercury", accountId: "mercury", amountCents: -2_500, postedDate: "2026-08-25", description: "Vendor" },
      ],
      notes: [],
    };
    const first = await readAnvilBiMercury(directory, null, { run: async () => JSON.stringify(firstSnapshot) });
    expect(first.status).toBe("ok");
    expect(first.items).toHaveLength(2);
    expect(first.items.map((item) => item.metadata?.externalId)).toEqual(["mercury_operating", "mercury_tx_1"]);

    const quiet = await readAnvilBiMercury(directory, first.cursor, { run: async () => JSON.stringify(firstSnapshot) });
    expect(quiet.status).toBe("empty");
    expect(quiet.items).toEqual([]);

    const changedSnapshot = {
      ...firstSnapshot,
      capturedAt: "2026-08-26T13:00:00.000Z",
      cashAccounts: [{ ...firstSnapshot.cashAccounts[0], balanceCents: 130_000, availableCents: 130_000 }],
      transactions: [
        ...firstSnapshot.transactions,
        { id: "mercury_tx_2", source: "mercury", accountId: "mercury", amountCents: 5_000, postedDate: "2026-08-26", description: "Customer receipt" },
      ],
    };
    const changed = await readAnvilBiMercury(directory, quiet.cursor, { run: async () => JSON.stringify(changedSnapshot) });
    expect(changed.status).toBe("ok");
    expect(changed.items.map((item) => item.metadata?.externalId)).toEqual(["mercury_operating", "mercury_tx_2"]);
  });

  it("fails closed on malformed or duplicate Anvil BI Mercury payloads", async () => {
    const directory = temporaryDirectory("omb-anvil-mercury-invalid-");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "anvil-bi" }));
    const adapterDirectory = join(directory, "apps", "server", "src", "integrations");
    mkdirSync(adapterDirectory, { recursive: true });
    writeFileSync(join(adapterDirectory, "mercury.ts"), "export {};\n");
    expect((await readAnvilBiMercury(directory, null, { run: async () => "{}" })).status).toBe("failed");
    const duplicate = {
      capturedAt: "2026-08-26T12:00:00.000Z",
      cashAccounts: [],
      transactions: [
        { id: "mercury_tx_1", source: "mercury", accountId: "mercury", amountCents: 1, postedDate: "2026-08-26", description: "One" },
        { id: "mercury_tx_1", source: "mercury", accountId: "mercury", amountCents: 2, postedDate: "2026-08-26", description: "Two" },
      ],
      notes: [],
    };
    const result = await readAnvilBiMercury(directory, null, { run: async () => JSON.stringify(duplicate) });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("duplicate Mercury transaction ids");
  });

  it("probes only explicitly configured loopback Telegram relay health", async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
    const result = await readTelegramRelayHealth("http://localhost:8787/api/health", { fetcher, now: () => 1_756_000_000_000 });
    expect(result.status).toBe("ok");
    expect(result.items[0]?.sourceId).toBe("telegram-relay");
    expect((await readTelegramRelayHealth("https://relay.example.test/health", { fetcher })).status).toBe("needs-config");
    expect((await readTelegramRelayHealth(null, { fetcher })).status).toBe("needs-config");
  });
});
