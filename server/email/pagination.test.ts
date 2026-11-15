import { beforeEach, describe, expect, it, vi } from "vitest";

import { listMessages, openGuard } from "./client.ts";
import type { EmailAccount } from "./store.ts";

const imap = vi.hoisted(() => ({
  search: vi.fn(),
  fetch: vi.fn(),
  release: vi.fn(),
  logout: vi.fn(async () => {}),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = { exists: 5 };
    on() {}
    async connect() {}
    async getMailboxLock() { return { release: imap.release }; }
    search = imap.search;
    fetch = imap.fetch;
    logout = imap.logout;
    close() {}
  },
}));

const account: EmailAccount = {
  address: "test@example.net", username: "test", password: "fixture-only", connectedAt: 0,
  imap: { host: "imap.example.net", port: 993, secure: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  imap.search.mockReset().mockResolvedValue([1, 2, 3, 4]);
  imap.fetch.mockImplementation(async function* (uids: number[]) {
    for (const uid of uids) yield { uid, envelope: { subject: `Message ${uid}` }, flags: new Set() };
  });
});

describe("Email pagination", () => {
  it("ends at UID 1 without asking the server for the invalid range 1:0", async () => {
    imap.search.mockRejectedValue(new Error("Invalid UID sequence 1:0"));
    await expect(listMessages(account, openGuard, { mailbox: "INBOX", limit: 20, beforeUid: 1 }))
      .resolves.toEqual({ total: 5, messages: [] });
    expect(imap.search).not.toHaveBeenCalled();
    expect(imap.fetch).not.toHaveBeenCalled();
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it("still searches older UIDs and returns the newest matching messages first", async () => {
    const page = await listMessages(account, openGuard, { mailbox: "INBOX", limit: 2, beforeUid: 5 });
    expect(imap.search).toHaveBeenCalledWith({ uid: "1:4" }, { uid: true });
    expect(imap.fetch.mock.calls[0][0]).toEqual([3, 4]);
    expect(page.total).toBe(5);
    expect(page.messages.map((message) => message.uid)).toEqual([4, 3]);
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it("returns an empty older page when the first existing UID is above 1", async () => {
    imap.search.mockResolvedValue([]);
    await expect(listMessages(account, openGuard, { mailbox: "INBOX", limit: 20, beforeUid: 4 }))
      .resolves.toEqual({ total: 5, messages: [] });
    expect(imap.search).toHaveBeenCalledWith({ uid: "1:3" }, { uid: true });
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
  });
});
