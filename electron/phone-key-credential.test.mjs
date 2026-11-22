// A phone's key save goes through the desktop's own credential:set path; the harness guards the same set of providers
// when the phone reaches it directly (the standalone companion), so the two lists must not drift.
import { describe, expect, it } from "vitest";

import { isPhoneKeyPatch, PROVIDER_KEY_KINDS } from "../server/provider-key-check.ts";
import { CREDENTIAL_PATCH, phoneKeyCredential } from "./credential-patch.mjs";

describe("a phone's config write as a credential:set call", () => {
  it.each([
    [{ mistral: { key: "k" } }, { name: "mistralApiKey", value: "k", options: undefined }],
    [{ openai: { key: "" } }, { name: "openaiApiKey", value: "", options: undefined }],
    [{ anthropic: { key: "k", everyClaudeBot: false } }, { name: "anthropicApiKey", value: "k", options: { everyClaudeBot: false } }],
  ])("maps %j", (patch, credential) => {
    expect(phoneKeyCredential(patch)).toEqual(credential);
  });

  it("refuses anything but one phone-settable provider's key", () => {
    for (const patch of [
      null, "k", [], {},
      { openaiCompat: { key: "k" } },
      { deepseek: { key: "k" } },
      { treg: { key: "k" } },
      { openai: { key: "k", url: "http://elsewhere.test/v1" } },
      { mistral: { key: "k", everyClaudeBot: true } },
      { anthropic: { key: "k", everyClaudeBot: "no" } },
      { anthropic: { everyClaudeBot: false } },
      { mistral: {} },
      { mistral: { key: 5 } },
      { mistral: "k" },
      { mistral: { key: "k" }, openai: { key: "k" } },
      { mistral: { key: "k" }, signIn: { admins: [] } },
      JSON.parse('{"__proto__": {"key": "k"}}'),
      { toString: { key: "k" } },
    ]) expect(phoneKeyCredential(patch), JSON.stringify(patch)).toBeNull();
  });

  it("agrees with the harness on every provider, and saves exactly the patch the phone sent", () => {
    const sections = new Set([...PROVIDER_KEY_KINDS, ...Object.values(CREDENTIAL_PATCH).map((patchFor) => Object.keys(patchFor("k"))[0])]);
    for (const section of sections) {
      const patch = { [section]: { key: "k" } };
      const credential = phoneKeyCredential(patch);
      expect(credential !== null, section).toBe(isPhoneKeyPatch(patch));
      if (credential) expect(CREDENTIAL_PATCH[credential.name](credential.value, credential.options), section).toEqual(patch);
    }
    const anthropic = { anthropic: { key: "k", everyClaudeBot: false } };
    const credential = phoneKeyCredential(anthropic);
    expect(CREDENTIAL_PATCH[credential.name](credential.value, credential.options)).toEqual(anthropic);
  });
});
