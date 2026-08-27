import { describe, expect, it } from "vitest";

import {
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
});
