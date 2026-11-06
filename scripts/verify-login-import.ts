import assert from "node:assert/strict";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
try {
  const api = fixtureApi(fixture.info.url);
  const entries = [{ site: "https://example.test", username: "fixture-user", password: "fixture-only-password" }];
  assert.deepEqual(await api("POST", "/api/logins/import", { entries, bots: "all" }), { imported: 1, skipped: 0 });
  assert.deepEqual(await api("POST", "/api/logins/import", { entries, bots: "all" }), { imported: 0, skipped: 1 });
  const saved = await api("GET", "/api/logins");
  assert.equal(saved.logins.length, 1);
  assert.equal(saved.logins[0].exactHost, true);
  assert.equal(JSON.stringify(saved).includes(entries[0]!.password), false);
  const ui = await mountPreview(fixture, {
    entry: "/scripts/testing/login-import-preview.tsx", route: "/__login-import.html", title: "Bulk login import fixture",
  });
  console.log(JSON.stringify({ apiVerified: true, previewUrl: ui.previewUrl }));
  try { await parkUntilSignal(); } finally { await ui.close(); }
} finally { await fixture.close(); }
