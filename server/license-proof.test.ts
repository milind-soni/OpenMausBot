import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { checkLicence, licenceProof } from "../connector/src/customer-run.ts";
import { licenseStateProof } from "./license-proof.ts";

// A throwaway signing pair, and a licence made as enterprise/server/license.ts issueLicenseKey makes one (base64url JSON
// claims, then the Ed25519 signature of that text): core is built and tested without enterprise/, so it is not imported.
const { privateKey } = generateKeyPairSync("ed25519");
const issue = (claims: Record<string, unknown>) => {
  const part = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `omb1.${part}.${sign(null, Buffer.from(part, "utf8"), privateKey).toString("base64url")}`;
};

describe("the licence a connected server is sent, as the connector and the server each see it", () => {
  it("passes the connector's shape check, and both sides make the same digest of it", () => {
    for (const claims of [
      { v: 1, customer: "Acme Analytical", features: ["budgets", "whitelabel"], issued: "2026-11-27", expires: "2026-12-30" },
      { v: 1, customer: "Acme Analytical", features: ["budgets", "whitelabel", "per-model-prices"], issued: "2026-11-27", expires: "2026-12-30",
        seats: 25, plan: "business-server", sub: "sub_0NsqTest", server: "5d0c6f2e-9c1a-4c57-8f0e-2b7a1d3e4f50", iat: 1_795_000_000_000 },
    ]) {
      const key = issue(claims);
      expect(checkLicence(key)).toBe(key);
      expect(licenseStateProof(key)).toBe(licenceProof(key));
      // The server reads the file trimmed; the connector writes it with a newline.
      expect(licenseStateProof(`${key}\n`)).toBe(licenceProof(key));
    }
  });
});
