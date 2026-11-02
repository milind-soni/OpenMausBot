import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InboxView } from "../../shared/inbox";
import { inboxView, messageRow, reportRow } from "@/testing/inbox-fixture";
import { api } from "./api";
import { currentInbox, doneInboxRow, forgetInbox, readInboxRow, refreshInbox, replyToInboxRow, setInboxView } from "./inbox";

vi.mock("./api", () => ({ api: vi.fn() }));

type Request = { path: string; resolve: (view: InboxView) => void; reject: (error: Error) => void; settled?: boolean };
let requests: Request[];
const done = inboxView([{ ...messageRow, unread: false, tab: "done" }]);
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
const reply = async (index: number, view: InboxView) => {
  requests[index]!.settled = true;
  requests[index]!.resolve(view);
  await flush();
};

beforeEach(() => {
  requests = [];
  vi.mocked(api).mockImplementation((path) => new Promise<InboxView>((resolve, reject) => {
    requests.push({ path, resolve, reject });
  }));
  setInboxView(inboxView([messageRow]));
});
afterEach(async () => {
  for (let n = 0; n < requests.length; n++) {
    if (!requests[n]!.settled) await reply(n, done);
  }
  setInboxView(null);
  vi.clearAllMocks();
});

it("keeps Done when an older read response arrives last, then reconciles the discarded snapshot", async () => {
  readInboxRow(messageRow);
  doneInboxRow(messageRow);
  await reply(1, done);
  await reply(0, inboxView([{ ...messageRow, unread: false }]));
  expect(currentInbox()?.rows[0]?.tab).toBe("done");
  expect(requests[2]?.path).toBe("/api/inbox");
  await reply(2, inboxView([{ ...done.rows[0]!, text: "Fresh server text" }]));
  expect(currentInbox()?.rows[0]?.text).toBe("Fresh server text");
});

it("discards a GET started before a successful mutation and reads again", async () => {
  const loading = refreshInbox();
  doneInboxRow(messageRow);
  await reply(1, done);
  await reply(0, inboxView([messageRow]));
  expect(currentInbox()?.rows[0]?.tab).toBe("done");
  expect(requests[2]?.path).toBe("/api/inbox");
  await reply(2, done);
  await loading;
});

it("keeps a newer refresh when an older mutation response arrives afterward", async () => {
  readInboxRow(messageRow);
  const loading = refreshInbox();
  await reply(1, inboxView([{ ...messageRow, unread: false, text: "Newer text" }]));
  await loading;
  await reply(0, inboxView([{ ...messageRow, unread: false }]));
  expect(currentInbox()?.rows[0]?.text).toBe("Newer text");
  expect(requests[2]?.path).toBe("/api/inbox");
});

it("overlays pending Done on a GET and refreshes after that mutation settles", async () => {
  doneInboxRow(messageRow);
  const loading = refreshInbox();
  await reply(1, inboxView([messageRow]));
  await loading;
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "done", unread: false });
  await reply(0, done);
  expect(requests[2]?.path).toBe("/api/inbox");
});

it("keeps another row's pending read when a Done snapshot lands", async () => {
  setInboxView(inboxView([messageRow, reportRow]));
  readInboxRow(messageRow);
  doneInboxRow(reportRow);
  await reply(1, inboxView([messageRow, { ...reportRow, tab: "done" }]));
  expect(currentInbox()?.rows[0]?.unread).toBe(false);
  expect(currentInbox()?.rows[1]?.tab).toBe("done");
});

it("discards a GET started during a mutation that completed before the GET landed", async () => {
  doneInboxRow(messageRow);
  const loading = refreshInbox();
  await reply(0, done);
  await reply(1, inboxView([messageRow]));
  expect(currentInbox()?.rows[0]?.tab).toBe("done");
  expect(requests[2]?.path).toBe("/api/inbox");
  await reply(2, done);
  await loading;
});

it("discards a GET that predates a successful message reply", async () => {
  const loading = refreshInbox();
  const sending = replyToInboxRow(inboxView(), messageRow, "Thanks");
  await reply(1, done);
  await sending;
  await reply(0, inboxView([{ ...messageRow, text: "Old snapshot" }]));
  expect(currentInbox()?.rows[0]?.text).toBe(messageRow.text);
  expect(requests[2]?.path).toBe("/api/inbox");
  await reply(2, done);
  await loading;
  expect(currentInbox()?.rows[0]?.tab).toBe("done");
});

it("removes a failed mutation's overlay and reconciles from the server", async () => {
  doneInboxRow(messageRow);
  requests[0]!.settled = true;
  requests[0]!.reject(new Error("offline"));
  await flush();
  expect(requests[1]?.path).toBe("/api/inbox");
  await reply(1, inboxView([messageRow]));
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: true });
});

it.each(["done", "read"] as const)("removes failed %s before recovery and reconciles after a failed GET", async (what) => {
  if (what === "done") doneInboxRow(messageRow);
  else readInboxRow(messageRow);
  expect(currentInbox()?.rows[0]?.unread).toBe(false);
  requests[0]!.settled = true;
  requests[0]!.reject(new Error("offline"));
  await flush();
  const beforeRecovery = currentInbox();
  expect(requests[1]?.path).toBe("/api/inbox");
  requests[1]!.settled = true;
  requests[1]!.reject(new Error("offline"));
  await flush();
  expect(requests).toHaveLength(2);
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: true });
  expect(beforeRecovery?.rows[0]).toMatchObject({ tab: "info", unread: true });
  const loading = refreshInbox();
  await reply(2, inboxView([{ ...messageRow, text: "Reconciled text", unread: false }]));
  await loading;
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: false, text: "Reconciled text" });
});

it("keeps another row's pending read when Done and recovery fail", async () => {
  setInboxView(inboxView([messageRow, { ...reportRow, unread: true }]));
  doneInboxRow(messageRow);
  readInboxRow({ ...reportRow, unread: true });
  requests[0]!.settled = true;
  requests[0]!.reject(new Error("offline"));
  await flush();
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: true });
  expect(currentInbox()?.rows[1]?.unread).toBe(false);
  requests[2]!.settled = true;
  requests[2]!.reject(new Error("offline"));
  await flush();
  expect(currentInbox()?.rows[0]?.tab).toBe("info");
  expect(currentInbox()?.rows[1]?.unread).toBe(false);
});

it("keeps confirmed Done when an overlapping read and recovery fail", async () => {
  doneInboxRow(messageRow);
  readInboxRow(messageRow);
  await reply(0, done);
  requests[1]!.settled = true;
  requests[1]!.reject(new Error("offline"));
  await flush();
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "done", unread: false });
  requests[2]!.settled = true;
  requests[2]!.reject(new Error("offline"));
  await flush();
  await reply(3, done);
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "done", unread: false });
});

it("keeps confirmed state and pending changes when message reply and recovery fail", async () => {
  setInboxView(inboxView([messageRow, { ...reportRow, unread: true }]));
  const sending = replyToInboxRow(inboxView(), messageRow, "Thanks").catch((error: unknown) => error);
  readInboxRow({ ...reportRow, unread: true });
  requests[0]!.settled = true;
  requests[0]!.reject(new Error("offline"));
  await flush();
  expect(await sending).toBeInstanceOf(Error);
  requests[2]!.settled = true;
  requests[2]!.reject(new Error("offline"));
  await flush();
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: true, text: messageRow.text });
  expect(currentInbox()?.rows[1]?.unread).toBe(false);
  const loading = refreshInbox();
  await reply(3, inboxView([{ ...messageRow, text: "Reconciled reply" }, { ...reportRow, unread: true }]));
  await loading;
  expect(currentInbox()?.rows[0]?.text).toBe("Reconciled reply");
  expect(currentInbox()?.rows[1]?.unread).toBe(false);
});

it("keeps the same row's pending read when Done fails", async () => {
  doneInboxRow(messageRow);
  readInboxRow(messageRow);
  requests[0]!.settled = true;
  requests[0]!.reject(new Error("offline"));
  await flush();
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: false });
});

it("removes failed Done from the latest confirmed snapshot", async () => {
  doneInboxRow(messageRow);
  const loading = refreshInbox();
  await reply(1, inboxView([{ ...messageRow, text: "Other client's edit" }]));
  await loading;
  requests[0]!.settled = true;
  requests[0]!.reject(new Error("offline"));
  await flush();
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: true, text: "Other client's edit" });
});

it("drops a GET that lands after the inbox is forgotten, and reads nothing more", async () => {
  const loading = refreshInbox();
  forgetInbox();
  await reply(0, inboxView([messageRow]));
  await loading;
  expect(currentInbox()).toBeNull();
  expect(requests).toHaveLength(1);
});

it("drops a read or Done answer that lands after the inbox is forgotten, and reads nothing more", async () => {
  readInboxRow(messageRow);
  doneInboxRow(messageRow);
  forgetInbox();
  await reply(0, inboxView([{ ...messageRow, unread: false }]));
  requests[1]!.settled = true;
  requests[1]!.reject(new Error("offline"));
  await flush();
  expect(currentInbox()).toBeNull();
  expect(requests).toHaveLength(2);
});

it("reads nothing after a message reply when the inbox was forgotten meanwhile", async () => {
  const sending = replyToInboxRow(inboxView(), messageRow, "Thanks");
  forgetInbox();
  await reply(0, done);
  await sending;
  expect(currentInbox()).toBeNull();
  expect(requests).toHaveLength(1);
});
