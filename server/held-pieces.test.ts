import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { SafeText, savedReplyText } from "./harness/safe-text.ts";
import { heldShape, maskHeldPieces } from "./held-pieces.ts";
import { addHeldSecretScrubber } from "./redact.ts";
import { HeldSecrets, secretForms } from "./vault-store.ts";

let seed = 11;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const body = `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ${pick(BASE64, 1150)}AgMBAAE=`;
const wrap = (text: string, width: number) => text.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
const PEM = `-----BEGIN PRIVATE KEY-----\n${wrap(body, 64)}\n-----END PRIVATE KEY-----\n`;
const KEY_ID = pick("0123456789abcdef", 40);
const SERVICE_ACCOUNT = {
  type: "service_account", project_id: "acme-reports-123456", private_key_id: KEY_ID, private_key: PEM,
  client_email: "reports@acme-reports-123456.iam.gserviceaccount.com", client_id: "104857263918273645512",
  auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/reports%40acme-reports-123456.iam.gserviceaccount.com",
  universe_domain: "googleapis.com",
};
const JSON_KEY = JSON.stringify(SERVICE_ACCOUNT, null, 2);
const MORE = "And that is the whole of it, nothing more to add here today. ";

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});
/** Held as the server holds a saved secret. */
function holdOnServer(...values: string[]): HeldSecrets {
  const held = new HeldSecrets({ version: 1, secretValues: () => values });
  unregister = addHeldSecretScrubber((text) => held.scrub(text), () => held.longest(), (text) => held.begun(text));
  return held;
}
let seq = 0;
function streamed(text: string, size = 7): string {
  const safe = new SafeText();
  let sent = "";
  for (let at = 0; at < text.length; at += size) {
    const out = safe.delta({ eventId: `e${++seq}`, provider: "fake", threadId: "t", createdAt: "", turnId: "turn-1", itemId: "turn-1:m1",
      type: "content.delta", streamKind: "assistant_text", delta: text.slice(at, at + size) } as RuntimeEvent);
    if (out?.type === "content.delta") sent += out.delta;
  }
  return sent;
}
/** Runs of 16+ base64 characters in `text` that lie in the key's body or the key id. */
const leaked = (text: string) => (text.match(/[A-Za-z0-9+/=]{16,}/g) ?? []).filter((run) => body.includes(run) || KEY_ID.includes(run) || body.includes(run.slice(1)));

describe("the pieces of a held value that spans lines", () => {
  it("are the key's body and the key id, never field names, URLs, markers or words", () => {
    const pem = heldShape(PEM, secretForms(PEM));
    expect(pem.bodies).toEqual([body]);
    expect(pem.tail, "the header and the first line of the body, in its JSON form").toBe("-----BEGIN PRIVATE KEY-----\\n".length + 64);
    const json = heldShape(JSON_KEY, secretForms(JSON_KEY));
    expect(json.bodies).toContain(KEY_ID);
    expect(json.bodies).toContain(body);
    expect(json.tail, "up to the key id, in its longest form (HTML-escaped quotes)").toBe(Math.max(...secretForms(JSON_KEY).filter((form) => /\s/.test(form)).map((form) => form.indexOf(KEY_ID) + KEY_ID.length)));
    expect(json.tail).toBeLessThan(200);
    const words = `service_account private_key_id client_x509_cert_url true -----END PRIVATE KEY----- ${SERVICE_ACCOUNT.auth_provider_x509_cert_url} ${SERVICE_ACCOUNT.token_uri} universe_domain googleapis.com`;
    expect(maskHeldPieces(words, [pem, json])).toBe(words);
  });

  it("make the saved message mask at least what it did, and any line or re-wrapping of the body", () => {
    holdOnServer(PEM, JSON_KEY);
    expect(savedReplyText(`Here: ${PEM}`)).toBe("Here: ••••••");
    expect(savedReplyText(`Here: ${JSON_KEY}`)).toBe("Here: ••••••");
    for (const reply of [wrap(body, 76), body.slice(300, 364), JSON.stringify(SERVICE_ACCOUNT), `-----BEGIN PRIVATE KEY-----\n${wrap(body, 70)}\n-----END PRIVATE KEY-----`]) {
      expect(leaked(savedReplyText(reply))).toEqual([]);
    }
  });
});

describe("a reply that echoes a held key, as it streams", () => {
  const replies: Array<[string, string]> = [
    ["the PEM key whole", `Here is the key:\n${PEM}${MORE.repeat(4)}`],
    ["the JSON key whole", `Here is the file:\n${JSON_KEY}\n${MORE.repeat(4)}`],
    ["part of the body", `Lines 5 to 8:\n${wrap(body, 64).split("\n").slice(4, 8).join("\n")}\n${MORE.repeat(4)}`],
    ["the body re-wrapped at 76", `Re-wrapped:\n${wrap(body, 76)}\n${MORE.repeat(4)}`],
    ["the PEM key re-wrapped at 70", `-----BEGIN PRIVATE KEY-----\n${wrap(body, 70)}\n-----END PRIVATE KEY-----\n${MORE.repeat(4)}`],
    ["one line of the body", `One line: ${body.slice(640, 704)} ${MORE.repeat(4)}`],
    ["the JSON key on one line", `Compact: ${JSON.stringify(SERVICE_ACCOUNT)} ${MORE.repeat(4)}`],
    ["the key id alone", `Its id is ${KEY_ID}. ${MORE.repeat(4)}`],
  ];

  it.each(replies)("sends nothing of any piece: %s", (_name, reply) => {
    holdOnServer(PEM, JSON_KEY);
    const sent = streamed(reply);
    expect(leaked(sent)).toEqual([]);
    expect(savedReplyText(reply).startsWith(sent)).toBe(true);
  });

  it("shows none of a whole key's skeleton, which its saved message hides", () => {
    holdOnServer(PEM, JSON_KEY);
    expect("Here is the file:\n".startsWith(streamed(`Here is the file:\n${JSON_KEY}\n${MORE.repeat(4)}`))).toBe(true);
    expect("Here is the key:\n".startsWith(streamed(`Here is the key:\n${PEM}${MORE.repeat(4)}`))).toBe(true);
  });

  it("streams a reply that does not mention them, holding back only a short tail", () => {
    holdOnServer(PEM, JSON_KEY);
    const reply = MORE.repeat(20);
    const sent = streamed(reply);
    expect(reply.startsWith(sent)).toBe(true);
    expect(sent.length, "the JSON key's tail: up to its key id, rounded up").toBeGreaterThanOrEqual(reply.length - 192 - 16);
  });
});
