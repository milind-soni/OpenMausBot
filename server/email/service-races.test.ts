import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { EmailConnectRequest } from "../../shared/email.ts";
import { createEmailService, type EmailServiceDeps } from "./service.ts";
import { EmailStore, MAX_EMAIL_ACCOUNTS } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-email-races-"));
  dirs.push(dataDir);
  const entered = barrier(), release = barrier();
  const test: NonNullable<EmailServiceDeps["test"]> = {
    mailbox: async () => ({ messages: 0 }),
    sending: async (login, server) => {
      if (login && server.host === "slow.example") { entered.resolve(); await release.promise; }
    },
  };
  const email = createEmailService({ dataDir, publicOnly: false, test });
  const request = (more: Partial<EmailConnectRequest> = {}): EmailConnectRequest => ({
    address: "me@example.test", password: "fixture-password", imapHost: "imap.example", smtpHost: "smtp.example", smtpSecurity: "tls", ...more,
  });
  const persisted = () => new EmailStore(dataDir).list();
  return { email, entered, release, request, persisted };
}

describe("mailbox settings while a network check is in flight", () => {
  it("does not let a slow connection replace a newer connection", async () => {
    const { email, entered, release, request, persisted } = fixture();
    const stale = email.connect(request({ smtpHost: "slow.example", password: "old-password" }));
    await entered.promise;
    expect(await email.connect(request({ password: "new-password" }))).toMatchObject({ ok: true });
    release.resolve();
    expect(await stale).toMatchObject({ ok: false });
    expect(persisted()).toMatchObject([{ password: "new-password", smtp: { host: "smtp.example" } }]);
  });

  it.each([false, true])("does not reconnect after disconnect (previously connected: %s)", async (connected) => {
    const { email, entered, release, request, persisted } = fixture();
    if (connected) expect((await email.connect(request())).ok).toBe(true);
    const stale = email.connect(request({ address: "ME@example.test", smtpHost: "slow.example" }));
    await entered.promise;
    expect(email.disconnect("me@example.test").state).toBe("signed-out");
    release.resolve();
    expect(await stale).toMatchObject({ ok: false });
    expect(persisted()).toEqual([]);
    expect((await email.connect(request())).ok).toBe(true);
  });

  it("does not let a slow outgoing check replace newer outgoing settings", async () => {
    const { email, entered, release, request, persisted } = fixture();
    await email.connect(request());
    const stale = email.checkOutgoing("me@example.test", { smtpHost: "slow.example", smtpSecurity: "tls", smtpUsername: "old-sender" });
    await entered.promise;
    expect(await email.checkOutgoing("ME@example.test", { smtpHost: "new.example", smtpSecurity: "tls", smtpUsername: "new-sender" })).toMatchObject({ ok: true });
    release.resolve();
    expect(await stale).toMatchObject({ ok: false });
    expect(persisted()).toMatchObject([{ smtp: { host: "new.example" }, smtpUsername: "new-sender" }]);
  });

  it("does not apply an old outgoing check after reconnecting with the same password", async () => {
    const { email, entered, release, request, persisted } = fixture();
    await email.connect(request());
    const stale = email.checkOutgoing("me@example.test", { smtpHost: "slow.example", smtpSecurity: "tls" });
    await entered.promise;
    expect(await email.connect(request({ imapHost: "new-imap.example", smtpHost: "new.example" }))).toMatchObject({ ok: true });
    release.resolve();
    expect(await stale).toMatchObject({ ok: false });
    expect(persisted()).toMatchObject([{ imap: { host: "new-imap.example" }, smtp: { host: "new.example" } }]);
  });

  it("does not let a slow reconnect revert a newer outgoing change", async () => {
    const { email, entered, release, request, persisted } = fixture();
    await email.connect(request());
    const stale = email.connect(request({ smtpHost: "slow.example" }));
    await entered.promise;
    expect(await email.checkOutgoing("me@example.test", { smtpHost: "new.example", smtpSecurity: "tls" })).toMatchObject({ ok: true });
    release.resolve();
    expect(await stale).toMatchObject({ ok: false });
    expect(persisted()).toMatchObject([{ smtp: { host: "new.example" } }]);
  });

  it("keeps unrelated mailbox operations independent", async () => {
    const { email, entered, release, request, persisted } = fixture();
    const slow = email.connect(request({ smtpHost: "slow.example" }));
    await entered.promise;
    expect((await email.connect(request({ address: "other@example.test" }))).ok).toBe(true);
    release.resolve();
    expect((await slow).ok).toBe(true);
    expect(persisted().map((account) => account.address).sort()).toEqual(["me@example.test", "other@example.test"]);
  });

  it("rechecks the account limit after the network check finishes", async () => {
    const { email, entered, release, request, persisted } = fixture();
    for (let index = 0; index < MAX_EMAIL_ACCOUNTS - 1; index++) {
      expect((await email.connect(request({ address: `saved${index}@example.test` }))).ok).toBe(true);
    }
    const stale = email.connect(request({ smtpHost: "slow.example" }));
    await entered.promise;
    expect((await email.connect(request({ address: "last@example.test" }))).ok).toBe(true);
    release.resolve();
    await expect(stale).resolves.toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_EMAIL_ACCOUNTS)) });
    expect(persisted()).toHaveLength(MAX_EMAIL_ACCOUNTS);
  });
});
