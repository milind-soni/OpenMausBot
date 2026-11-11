import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDENTIAL_PATCH, credentialSaveError } from "./credential-patch.mjs";
import nativeText from "./native-text.cjs";

test("a speech input key is saved together with the endpoint it was entered for", () => {
  assert.deepEqual(CREDENTIAL_PATCH.sttKey("secret", { provider: "openai", baseUrl: "https://api.groq.com/openai/v1" }),
    { stt: { provider: "openai", baseUrl: "https://api.groq.com/openai/v1", key: "secret" } });
  assert.deepEqual(CREDENTIAL_PATCH.sttKey(""), { stt: { key: "" } });
});

test("a key the provider refused crosses IPC named KeyRejected, with the server's words", () => {
  const error = credentialSaveError(400, { error: "boat.dev rejected that key", code: "key_rejected" });
  assert.equal(error.toString(), "KeyRejected: boat.dev rejected that key");
  assert.equal(`Error invoking remote method 'credential:set': ${error}`, "Error invoking remote method 'credential:set': KeyRejected: boat.dev rejected that key");
});

test("fixed decider refusals use native words before Electron serializes the error", () => {
  const t = nativeText.createNativeText({ saved: "pt-br" }).t;
  const cases = [
    ["accountRequired", "Add your Cloudflare account ID with the token.", "Adicione o ID da conta da Cloudflare junto com o token."],
    ["jevRejected", "Jev rejected this key. Check it at typesafe.ai and paste it again.", "O Jev recusou esta chave. Confira em typesafe.ai e cole novamente."],
    ["workersRejected", "Cloudflare rejected this token. Check that it has Workers AI permission and belongs to this account ID.", "A Cloudflare recusou este token. Confira se ele tem permissão para Workers AI e pertence à conta com este ID."],
    ["routerRejected", "OpenRouter rejected this key. Check it at openrouter.ai/keys and paste it again.", "O OpenRouter recusou esta chave. Confira em openrouter.ai/keys e cole novamente."],
  ];
  for (const [suffix, english, portuguese] of cases) {
    const body = { error: english, errorKey: `serverError.decider.${suffix}`, code: "decider_rejected" };
    assert.equal(credentialSaveError(400, body).message, english);
    assert.equal(credentialSaveError(400, body, t).message, portuguese);
    assert.equal(credentialSaveError(400, { ...body, error: "Vendor technical detail" }, t).message, "Vendor technical detail");
    assert.equal(credentialSaveError(400, { ...body, errorKey: "constructor" }, t).message, english);
    assert.equal(credentialSaveError(400, { ...body, code: "key_rejected" }, t).name, "KeyRejected");
  }
});

test("every other refusal stays a plain Error", () => {
  for (const [status, body] of [[400, { error: "Couldn't reach boat.dev" }], [409, { error: "busy", code: "conflict" }], [503, null], [403, { code: "KeyRejected" }]]) {
    const error = credentialSaveError(status, body);
    assert.ok(error.toString().startsWith("Error: "), error.toString());
    assert.ok(!error.toString().startsWith("KeyRejected: "));
  }
  assert.equal(credentialSaveError(503, null).message, "Could not save credential (HTTP 503)");
});
