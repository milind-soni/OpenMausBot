import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { Client, fakeHost, keysJson, phoneHello, startTestRelay, testKey, type TestRelay } from "./helpers.ts";

const APP = "https://app.example.com";
const base = { RELAY_NODE: "relay1", RELAY_TOKEN_KEYS: keysJson(testKey()) };

describe("RELAY_PHONE_ORIGINS", () => {
  test("unset or empty lets no browser page in", () => {
    assert.deepEqual([...loadConfig(base).phoneOrigins], []);
    assert.deepEqual([...loadConfig({ ...base, RELAY_PHONE_ORIGINS: " " }).phoneOrigins], []);
  });

  test("lists exact https:// origins, comma-separated", () => {
    const { phoneOrigins } = loadConfig({ ...base, RELAY_PHONE_ORIGINS: ` ${APP} , https://web.example.org:8443,` });
    assert.deepEqual([...phoneOrigins], [APP, "https://web.example.org:8443"]);
  });

  test("accepts IP literal hosts as browsers send them", () => {
    const value = "https://[::1]:8443,https://[fd00::a:1],https://192.168.1.20:8443";
    assert.deepEqual([...loadConfig({ ...base, RELAY_PHONE_ORIGINS: value }).phoneOrigins], value.split(","));
  });

  test("accepts a fully qualified name with a trailing dot as its own origin", () => {
    const { phoneOrigins } = loadConfig({ ...base, RELAY_PHONE_ORIGINS: "https://app.example.com." });
    assert.deepEqual([...phoneOrigins], ["https://app.example.com."]);
    assert.equal(phoneOrigins.has(APP), false);
  });

  test("refuses anything that is not an exact https:// origin, and never repeats it", () => {
    const bad = [
      "http://app.example.com",
      "https://app.example.com/",
      "https://app.example.com/pair",
      "https://app.example.com?x=1",
      "https://app.example.com#x",
      "https://user@app.example.com",
      "https://App.example.com",
      "https://app.example.com:443",
      "https://*.example.com",
      "https://*",
      "https://[0:0::1]",
      "https://[::1]:443",
      "app.example.com",
      "null",
      `${APP},ftp://files.example.com`,
    ];
    for (const value of bad) {
      assert.throws(
        () => loadConfig({ ...base, RELAY_PHONE_ORIGINS: value }),
        (error: Error) => error.message.startsWith("RELAY_PHONE_ORIGINS") && !error.message.includes(value),
        value,
      );
    }
  });

  test("at most 8", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `https://app${i}.example.com`).join(",");
    assert.throws(() => loadConfig({ ...base, RELAY_PHONE_ORIGINS: nine }), /RELAY_PHONE_ORIGINS/);
    assert.equal(loadConfig({ ...base, RELAY_PHONE_ORIGINS: nine.split(",").slice(0, 8).join(",") }).phoneOrigins.size, 8);
  });
});

describe("a relay without RELAY_PHONE_ORIGINS", () => {
  let relay: TestRelay;
  before(async () => {
    relay = await startTestRelay({}, { phoneOrigins: [...loadConfig(base).phoneOrigins] });
  });
  after(() => relay.stop());

  test("refuses every browser page on /v1/phone", async () => {
    assert.equal(await Client.refusal(relay.url, "/v1/phone", { headers: { origin: APP } }), 403);
    assert.equal(await Client.refusal(relay.url, "/v1/phone"), 101);
  });
});

describe("a relay with RELAY_PHONE_ORIGINS", () => {
  let relay: TestRelay;
  before(async () => {
    relay = await startTestRelay({}, { phoneOrigins: [APP] });
  });
  after(() => relay.stop());

  test("a listed origin may open /v1/phone and nothing else", async () => {
    const origin = (value: string) => ({ headers: { origin: value } });
    assert.equal(await Client.refusal(relay.url, "/v1/phone", origin(APP)), 101);
    assert.equal(await Client.refusal(relay.url, "/v1/phone"), 101);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", origin("https://other.example.com")), 403);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", origin("http://app.example.com")), 403);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", origin("null")), 403);
    assert.equal(await Client.refusal(relay.url, "/v1/host", origin(APP)), 403);
    assert.equal(await Client.refusal(relay.url, "/v1/host/data", origin(APP)), 403);
  });

  test("a phone page from a listed origin reaches its host", async () => {
    const adm = randomBytes(32);
    const host = await fakeHost(relay.url, relay.key, [adm]);
    const phone = await phoneHello(relay.url, host.hidText, adm, { headers: { origin: APP } });
    assert.equal((await host.control.json()).t, "open");
    phone.ws.terminate();
    host.control.ws.close();
  });
});

describe("a relay that lists only a trailing-dot origin", () => {
  const DOTTED = `${APP}.`;
  let relay: TestRelay;
  before(async () => {
    relay = await startTestRelay({}, { phoneOrigins: [...loadConfig({ ...base, RELAY_PHONE_ORIGINS: DOTTED }).phoneOrigins] });
  });
  after(() => relay.stop());

  test("lets in the dotted spelling only, never the undotted one", async () => {
    assert.equal(await Client.refusal(relay.url, "/v1/phone", { headers: { origin: DOTTED } }), 101);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", { headers: { origin: APP } }), 403);
  });
});
