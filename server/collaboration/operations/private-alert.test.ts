import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openCollaborationLedger } from "../db.ts";
import { LocalOwnerRegistry } from "../owner.ts";
import {
  FetchPrivateOwnerAlertSink,
  LedgerPrivateOwnerAlertPort,
  type PrivateOwnerAlertSink,
  type SafeOperationalAlert,
  ValidatingPrivateOwnerAlertPort,
} from "./private-alert.ts";

class FakePrivateSink implements PrivateOwnerAlertSink {
  readonly deliveries: Array<{ target: string; alert: Readonly<SafeOperationalAlert> }> = [];

  async sendPrivate(target: string, alert: Readonly<SafeOperationalAlert>): Promise<void> {
    this.deliveries.push({ target, alert });
  }
}

class FakeProjectGroupOutbox {
  readonly progress: string[] = [];

  enqueueProgress(message: string): void {
    this.progress.push(message);
  }
}

const digest = `sha256:${"a".repeat(64)}`;

describe("private Owner operational alerts", () => {
  it("routes operational alerts only to the private sink", async () => {
    const group = new FakeProjectGroupOutbox();
    const privateSink = new FakePrivateSink();
    const alerts = new ValidatingPrivateOwnerAlertPort("owner-staff-id", privateSink);

    await alerts.alert({ code: "disk_low", digest, occurredAt: 1_000 });

    expect(privateSink.deliveries).toEqual([
      { target: "owner-staff-id", alert: { code: "disk_low", digest, occurredAt: 1_000 } },
    ]);
    expect(group.progress).toEqual([]);
  });

  it("fails closed when no private target is configured", async () => {
    const privateSink = new FakePrivateSink();
    const alerts = new ValidatingPrivateOwnerAlertPort(null, privateSink);

    await expect(alerts.alert({ code: "disk_low", digest, occurredAt: 1_000 })).rejects.toThrow(
      "target is not configured",
    );
    expect(privateSink.deliveries).toEqual([]);
  });

  it("rejects raw messages, unsafe codes, and non-digest payloads", async () => {
    const privateSink = new FakePrivateSink();
    const alerts = new ValidatingPrivateOwnerAlertPort("owner", privateSink);

    await expect(
      alerts.alert({ code: "disk_low", digest, occurredAt: 1_000, message: "secret-token" } as SafeOperationalAlert),
    ).rejects.toThrow("accept only");
    await expect(alerts.alert({ code: "Disk low: /secret", digest, occurredAt: 1_000 })).rejects.toThrow(
      "code is not safe",
    );
    await expect(alerts.alert({ code: "disk_low", digest: "raw error text", occurredAt: 1_000 })).rejects.toThrow(
      "SHA-256",
    );
    expect(privateSink.deliveries).toEqual([]);
  });

  it("resolves the current sole Owner and posts only safe fields through a secure private relay reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "private-owner-alert-"));
    try {
      const ledger = openCollaborationLedger(root);
      const owner = new LocalOwnerRegistry(ledger.filePath);
      owner.bootstrap({ senderCorpId: "corp", senderStaffId: "owner", now: 1 });
      owner.close();
      const database = new DatabaseSync(ledger.filePath);
      ledger.close();
      const endpoint = join(root, "private-alert.url");
      writeFileSync(endpoint, "https://alerts.example.test/private-owner", { mode: 0o600 });
      const requests: Array<{ url: string; body: unknown }> = [];
      const sink = new FetchPrivateOwnerAlertSink(endpoint, async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      });
      await new LedgerPrivateOwnerAlertPort(database, sink).alert({ code: "disk_low", digest, occurredAt: 2 });
      expect(requests).toEqual([
        {
          url: "https://alerts.example.test/private-owner",
          body: { target: "corp:owner", code: "disk_low", digest, occurredAt: 2 },
        },
      ]);
      expect(JSON.stringify(requests)).not.toContain("clientSecret");
      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
