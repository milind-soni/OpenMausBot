import { describe, expect, it } from "vitest";

import { normalizedPhoneSecretPublicKey } from "../src/phone-secret-key.ts";

const publicKey =
  "BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU";

describe("phone secret public key", () => {
  it("accepts a canonical on-curve P-256 point", () => {
    expect(normalizedPhoneSecretPublicKey(publicKey)).toBe(publicKey);
  });

  it("rejects malformed and off-curve points", () => {
    const offCurve = Buffer.alloc(65);
    offCurve[0] = 4;

    expect(normalizedPhoneSecretPublicKey(publicKey.slice(1))).toBeNull();
    expect(normalizedPhoneSecretPublicKey(`${publicKey}=`)).toBeNull();
    expect(normalizedPhoneSecretPublicKey(offCurve.toString("base64url"))).toBeNull();
  });
});
