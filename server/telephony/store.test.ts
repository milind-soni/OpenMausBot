import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTelephonyStore, telephonyStoreFile } from "./store.ts";

const dirs: string[] = [];
const storeAt = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-telephony-"));
  dirs.push(dir);
  return openTelephonyStore(join(dir, "telephony", "store.json"));
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("The telephony store", () => {
  it("defaults into the data dir and honors the env override", () => {
    expect(telephonyStoreFile({})).toMatch(/[\\/]telephony[\\/]store\.json$/);
    expect(telephonyStoreFile({ OMB_TELEPHONY_STORE: "/tmp/custom/store.json" })).toBe("/tmp/custom/store.json");
  });

  it("keeps SMS, calls and facts in one file across channels", () => {
    const store = storeAt();
    store.appendSms({ direction: "in", from: "+15187446390", to: "+15186608998", body: "are you free for lunch?", at: 1, status: "received" });
    const call = store.appendCall({ direction: "in", from: "+15187446390", to: "+15186608998", at: 2, status: "answered" });
    store.appendCallTurn(call.id, { who: "caller", text: "remind me to rotate tires", at: 3 });
    store.appendFact("The owner's car needs a tire rotation every 8,000 miles.", "phone");

    const reopened = openTelephonyStore(store.file);
    expect(reopened.listSms()[0]!.body).toBe("are you free for lunch?");
    expect(reopened.listCalls()[0]!.turns).toEqual([{ who: "caller", text: "remind me to rotate tires", at: 3 }]);
    expect(reopened.facts()[0]!.source).toBe("phone");
  });

  it("redacts secrets out of free text before it lands on disk", () => {
    const store = storeAt();
    store.appendSms({ direction: "in", from: "+15180000000", to: "+15186608998", body: "key sk-abc123secretvalue here", at: 1, status: "received" });
    store.appendFact("token glpat-abcdefghij1234567890 in a fact", "sms");
    const raw = readFileSync(store.file, "utf8");
    expect(raw).not.toContain("sk-abc123secretvalue");
    expect(raw).not.toContain("glpat-abcdefghij1234567890");
  });

  it("patches an SMS to sent and keeps the newest rows first", () => {
    const store = storeAt();
    const first = store.appendSms({ direction: "in", from: "+15180000001", to: "+15186608998", body: "one", at: 1, status: "received" });
    store.appendSms({ direction: "in", from: "+15180000002", to: "+15186608998", body: "two", at: 2, status: "received" });
    store.patchSms(first.id, { status: "sent", proposedReply: undefined });
    expect(store.listSms()[0]!.body).toBe("two");
    expect(store.listSms()[1]!.status).toBe("sent");
  });

  it("serves recent context across every channel for a fresh turn", () => {
    const store = storeAt();
    store.appendFact("owner prefers texts over calls", "phone");
    store.appendSms({ direction: "in", from: "+15180000003", to: "+15186608998", body: "running late", at: 1, status: "received" });
    const call = store.appendCall({ direction: "in", from: "+15180000003", to: "+15186608998", at: 2, status: "answered" });
    store.appendCallTurn(call.id, { who: "bot", text: "noted, see you at six", at: 3 });
    const context = store.recentContext();
    expect(context.join("\n")).toContain("owner prefers texts over calls");
    expect(context.join("\n")).toContain("running late");
    expect(context.join("\n")).toContain("see you at six");
  });
});