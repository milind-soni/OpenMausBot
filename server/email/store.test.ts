import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EMAIL_FILE, EmailStore, type EmailAccount } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const account: EmailAccount = {
  address: "person@example.com", username: "person", password: "synthetic-password",
  imap: { host: "mail.example.com", port: 993, secure: true }, connectedAt: 1,
};

describe("EmailStore", () => {
  it("keeps the last mailbox available for retry when deleting its file fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-email-store-"));
    dirs.push(dir);
    const store = new EmailStore(dir);
    store.put(account);
    const file = join(dir, EMAIL_FILE);
    const kept = `${file}.kept`;
    renameSync(file, kept);
    mkdirSync(file);

    expect(() => store.remove(account.address)).toThrow();
    expect(store.get(account.address)).toEqual(account);

    rmSync(file, { recursive: true });
    renameSync(kept, file);
    expect(store.remove(account.address)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(new EmailStore(dir).list()).toEqual([]);
    expect(store.remove(account.address)).toBe(false);
  });
});
