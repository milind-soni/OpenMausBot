import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { approvalKey, browserCaptureEndpoint, sourceForUrl, submitReceipt } from "./background.js";

test("accepts only supported HTTPS sources", () => {
  assert.equal(sourceForUrl("https://messages.google.com/web/conversations"), "google-messages");
  assert.equal(sourceForUrl("https://plaud.ai/recordings"), "plaud");
  assert.equal(sourceForUrl("https://app.monarch.com/dashboard"), "monarch");
  assert.equal(sourceForUrl("https://monarchmoney.com/dashboard"), "monarch");
  assert.equal(sourceForUrl("https://app.mercury.com/dashboard"), "mercury");
  assert.equal(sourceForUrl("https://chatgpt.com/"), "ai-chatgpt");
  assert.equal(sourceForUrl("https://claude.ai/"), "ai-claude");
  assert.equal(sourceForUrl("https://grok.com/"), "ai-grok");
  assert.equal(sourceForUrl("https://gemini.google.com/app"), "ai-gemini");
  assert.equal(sourceForUrl("http://app.mercury.com/dashboard"), null);
  assert.equal(sourceForUrl("https://example.com/"), null);
});

test("approval state is isolated by tab", () => {
  assert.notEqual(approvalKey(10), approvalKey(11));
});

test("automatic capture posts silently without download permission", async () => {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:8799/*"));

  const receipt = { schemaVersion: 1, sourceId: "plaud", captureId: "00000000-0000-4000-8000-000000000001" };
  let request;
  await submitReceipt(receipt, async (url, init) => {
    request = { url, init };
    return new Response(null, { status: 204 });
  });

  assert.equal(request.url, browserCaptureEndpoint);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-openmausbot-capture"], "1");
  assert.deepEqual(JSON.parse(request.init.body), receipt);
});
