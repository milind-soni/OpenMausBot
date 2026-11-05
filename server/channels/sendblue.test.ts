import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeSendblue, type FakeSendblue } from "../testing/fake-sendblue.ts";
import { checkCredentialText, createSendblueApi, inboundOf, normalizeNumber, packCredentials, sendblueApiBase, sendblueLink, SENDBLUE_PAGE, unpackCredentials, type SendblueCredentials } from "./sendblue.ts";

const SCOUT: SendblueCredentials = { keyId: "key-scout-0001", secret: "secret-scout-aaaa-bbbb", number: "+14155550100" };
const ADA = "+14155550123";
const BEN = "+14155550124";

let fake: FakeSendblue;
let api: ReturnType<typeof createSendblueApi>;

beforeEach(async () => {
  fake = await startFakeSendblue({ [SCOUT.keyId]: { secret: SCOUT.secret, number: SCOUT.number } });
  api = createSendblueApi({ base: fake.url });
});
afterEach(() => fake.close());

const inbound = async (since = 0) => {
  const read = await api.listInbound(packCredentials(SCOUT), since);
  if (!read.ok) throw new Error(read.error);
  return read;
};

describe("the Sendblue API client", () => {
  it("accepts a key and number that belong together and says why it refuses any other", async () => {
    expect(await api.verify(SCOUT)).toEqual({ ok: true });
    expect(await api.verify({ ...SCOUT, secret: "wrong-secret-wrong" })).toEqual({ ok: false, error: expect.stringContaining("doesn't know that API key ID and secret") });
    expect(await api.verify({ ...SCOUT, number: "+14155550199" })).toEqual({ ok: false, error: "That number isn't on this Sendblue account." });
  });

  it("lists only inbound messages for the number, oldest first, from the time asked", async () => {
    const before = Date.now();
    fake.push(SCOUT.keyId, ADA, "one");
    fake.push(SCOUT.keyId, BEN, "two");
    const read = await inbound(before - 1000);
    expect(read.items.map((message) => message.content)).toEqual(["one", "two"]);
    const query = fake.polls.get(SCOUT.keyId)!.query!;
    expect(Object.fromEntries(query)).toMatchObject({ is_outbound: "false", sendblue_number: SCOUT.number, order_by: "createdAt", order_direction: "asc", limit: String(SENDBLUE_PAGE) });
    expect((await inbound(Date.now() + 60_000)).items).toEqual([]);
  });

  it("says there is more when the page is full and the newest message is past the cursor", async () => {
    const start = Date.now();
    for (let i = 0; i < SENDBLUE_PAGE; i++) fake.push(SCOUT.keyId, ADA, `m${i}`);
    expect((await inbound(start - 1000)).more).toBe(true);
    expect((await inbound(Date.now() + 60_000)).more).toBe(false);
  });

  it("turns an inbound message into one the core hears, and drops groups and our own", () => {
    const base = { message_handle: "h1", content: "  hello  ", number: ADA, from_number: ADA, is_outbound: false };
    expect(inboundOf(base)).toEqual({ id: "sb_h1", chatId: ADA, text: "hello", private: true });
    expect(inboundOf({ ...base, number: undefined })).toMatchObject({ chatId: ADA });
    expect(inboundOf({ ...base, content: null })).toMatchObject({ text: "" });
    expect(inboundOf({ ...base, group_id: "g1" })).toBeNull();
    expect(inboundOf({ ...base, is_outbound: true })).toBeNull();
  });

  it("sends plain text from the bot's number to the chat", async () => {
    fake.push(SCOUT.keyId, ADA, "hi");
    expect(await api.sendMessage(packCredentials(SCOUT), ADA, "Hello back.")).toEqual({ ok: true });
    expect(fake.sent).toEqual([{ keyId: SCOUT.keyId, to: ADA, from: SCOUT.number, content: "Hello back." }]);
  });

  it("reports Sendblue's refusal in its words, and never the key or the secret", async () => {
    const refused = await api.sendMessage(packCredentials(SCOUT), BEN, "Hello?");
    expect(refused).toEqual({ ok: false, error: expect.stringContaining("verified contacts") });
    fake.failSends(true);
    expect(await api.sendMessage(packCredentials(SCOUT), ADA, "Hello?")).toEqual({ ok: false, error: "The recipient is not a verified contact." });
    fake.failLists(429);
    const slow = await api.listInbound(packCredentials(SCOUT), 0);
    expect(slow).toMatchObject({ ok: false, error: expect.stringContaining("Slow down") });
    for (const result of [refused, slow, await api.verify({ ...SCOUT, secret: "wrong-secret-wrong" })]) {
      expect(JSON.stringify(result)).not.toContain(SCOUT.secret);
      expect(JSON.stringify(result)).not.toContain("wrong-secret-wrong");
      expect(JSON.stringify(result)).not.toContain(SCOUT.keyId);
    }
  });

  it("reports an unreachable server as such and leaks nothing", async () => {
    await fake.close();
    const gone = await api.sendMessage(packCredentials(SCOUT), ADA, "Hi");
    expect(gone).toEqual({ ok: false, error: expect.stringContaining("could not be reached") });
    expect(JSON.stringify(gone)).not.toContain(SCOUT.secret);
    expect(await api.listInbound("not json", 0)).toMatchObject({ ok: false, error: expect.stringContaining("Connect it again") });
  });
});

describe("what the person types", () => {
  it("normalizes a phone number to E.164 and refuses one without a country code", () => {
    expect(normalizeNumber("+1 (415) 555-0100")).toEqual({ ok: true, number: "+14155550100" });
    expect(normalizeNumber("415-555-0100")).toMatchObject({ ok: false, error: expect.stringContaining("country code") });
    expect(normalizeNumber("+0123456")).toMatchObject({ ok: false });
  });

  it("refuses a key or secret that is not one visible token", () => {
    expect(checkCredentialText("key-1", "secret-1")).toBeNull();
    expect(checkCredentialText("key 1", "secret-1")).toMatch(/doesn't look like/);
    expect(checkCredentialText("key-1", "secret\n1")).toMatch(/doesn't look like/);
    expect(checkCredentialText("", "secret-1")).toMatch(/doesn't look like/);
  });

  it("packs and unpacks the sealed credentials, and reads nothing else", () => {
    expect(unpackCredentials(packCredentials(SCOUT))).toEqual(SCOUT);
    expect(unpackCredentials("")).toBeNull();
    expect(unpackCredentials("{\"keyId\":\"a\"}")).toBeNull();
  });
});

describe("the address and the link", () => {
  it("takes a loopback stand-in from the environment and nothing else", () => {
    expect(sendblueApiBase({ OMB_SENDBLUE_API_BASE: "http://127.0.0.1:4321" })).toBe("http://127.0.0.1:4321");
    expect(sendblueApiBase({ OMB_SENDBLUE_API_BASE: "https://evil.example" })).toBe("https://api.sendblue.com");
    expect(sendblueApiBase({ OMB_SENDBLUE_API_BASE: "http://localhost:4321" })).toBe("https://api.sendblue.com");
    expect(sendblueApiBase({})).toBe("https://api.sendblue.com");
  });

  it("is the sms link that opens Messages with the command ready", () => {
    expect(sendblueLink("+14155550100", "123456")).toBe("sms:+14155550100&body=link%20123456");
  });
});
