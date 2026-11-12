import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { parseForm, twilioSignature, verifyTwilioSignature } from "./signature.ts";

const TOKEN = "twilio-auth-token";
const URL = "https://bots.example.com/hooks/telephony/voice";
const PARAMS = { From: "+15187446390", To: "+15186608998", Body: "hello there" };

describe("Twilio signatures", () => {
  it("computes the documented HMAC-SHA1 over url + sorted params", () => {
    const sorted = "Bodyhello thereFrom+15187446390To+15186608998";
    const expected = createHmac("sha1", TOKEN).update(`${URL}${sorted}`).digest("base64");
    expect(twilioSignature(URL, PARAMS, TOKEN)).toBe(expected);
  });

  it("accepts a valid signature and rejects the rest", () => {
    const valid = twilioSignature(URL, PARAMS, TOKEN);
    expect(verifyTwilioSignature({ url: URL, params: PARAMS, header: valid, token: TOKEN })).toBe(true);
    expect(verifyTwilioSignature({ url: URL, params: PARAMS, header: "wrong", token: TOKEN })).toBe(false);
    expect(verifyTwilioSignature({ url: URL, params: PARAMS, header: undefined, token: TOKEN })).toBe(false);
    expect(verifyTwilioSignature({ url: URL, params: PARAMS, header: valid, token: "" })).toBe(false);
    expect(
      verifyTwilioSignature({
        url: URL,
        params: { ...PARAMS, From: "+15550000000" },
        header: valid,
        token: TOKEN,
      }),
    ).toBe(false);
  });

  it("signs through a URL change the way a proxy would see it", () => {
    const signedForHttps = twilioSignature(URL, PARAMS, TOKEN);
    expect(
      verifyTwilioSignature({ url: "http://127.0.0.1:8080/hooks/telephony/voice", params: PARAMS, header: signedForHttps, token: TOKEN }),
    ).toBe(false);
  });

  it("parses form-encoded webhook bodies", () => {
    expect(parseForm("From=%2B1518&Body=hello%20there&Digits=5")).toEqual({
      From: "+1518",
      Body: "hello there",
      Digits: "5",
    });
  });
});