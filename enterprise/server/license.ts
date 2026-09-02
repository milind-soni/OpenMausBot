// License keys: signed entitlement claims.
//
// A key is `omb1.<claims>.<signature>`: base64url JSON claims, Ed25519-signed
// by an OpenMausBot signing key. The public keys are baked in below, so one
// build serves every customer — the key, not the code, decides the feature
// set. Verification is offline; nothing phones home.
import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKeyInput } from "node:crypto";
import { z } from "zod";

/** Ed25519 public keys (JWK `x`), oldest first. Rotate by appending; never edit or remove
 * an entry while a key signed with it is still in the field. The matching private keys are
 * generated with scripts/issue-license.mjs and stay outside the repo. */
export const LICENSE_PUBLIC_KEYS: readonly string[] = [
  "6CHdwwJzxKJFimRkC79eQ5FR__bX2WaU2BBGNGPQTQU",
];

export const claimsSchema = z.object({
  v: z.literal(1),
  /** Who the license was issued to; shown in the UI and the startup log. */
  customer: z.string().min(1),
  /** Entitlement ids, e.g. whitelabel, sso, admin, budgets. Unknown ids are carried, not rejected. */
  features: z.array(z.string().min(1)),
  /** ISO date (YYYY-MM-DD) the key was issued. */
  issued: z.iso.date("issued must be a YYYY-MM-DD date"),
  /** ISO date (YYYY-MM-DD) the key stops working, or null for perpetual. */
  expires: z.iso.date("expires must be a YYYY-MM-DD date").nullable(),
});

export type LicenseClaims = z.infer<typeof claimsSchema>;

const PREFIX = "omb1";

function publicKeyFromX(x: string) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

/** Verify a key and return its claims. Every failure names what to do next. */
export function verifyLicenseKey(
  key: string,
  options: { publicKeys?: readonly string[]; now?: Date } = {},
): LicenseClaims {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) {
    throw new Error(`OMB_LICENSE_KEY is not an OpenMausBot license key (expected "${PREFIX}.<claims>.<signature>")`);
  }
  const [, claimsPart, signaturePart] = parts;
  const signature = Buffer.from(signaturePart, "base64url");
  const signed = Buffer.from(claimsPart, "utf8");
  const trusted = (options.publicKeys ?? LICENSE_PUBLIC_KEYS).some((x) =>
    verify(null, signed, publicKeyFromX(x), signature),
  );
  if (!trusted) {
    throw new Error(
      "OMB_LICENSE_KEY signature does not match any OpenMausBot signing key: the key was altered, or it was issued for a different build",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
  } catch {
    throw new Error("OMB_LICENSE_KEY claims are not JSON; ask for the key to be reissued");
  }
  const result = claimsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`OMB_LICENSE_KEY claims are malformed (${result.error.issues[0]?.message ?? "invalid"}); ask for the key to be reissued`);
  }
  const claims = result.data;
  if (claims.expires !== null) {
    const expires = new Date(claims.expires);
    if ((options.now ?? new Date()) >= expires) {
      throw new Error(`OMB_LICENSE_KEY expired on ${claims.expires}; renew it to keep enterprise features`);
    }
  }
  return claims;
}

/** Issue a key. Used by scripts/issue-license.mjs and by tests; the private JWK never enters the repo. */
export function issueLicenseKey(claims: LicenseClaims, privateJwk: JsonWebKeyInput["key"]): string {
  const claimsPart = Buffer.from(JSON.stringify(claimsSchema.parse(claims)), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(claimsPart, "utf8"), createPrivateKey({ key: privateJwk, format: "jwk" }));
  return `${PREFIX}.${claimsPart}.${signature.toString("base64url")}`;
}
