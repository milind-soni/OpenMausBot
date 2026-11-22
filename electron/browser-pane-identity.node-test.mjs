import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PANE_IDENTITY_RULES, paneBaseUserAgent, paneIdentityMode, paneRequestUserAgent, paneTabUserAgent, withoutAppToken } from "./browser-pane-identity.mjs";

const ELECTRON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OpenMausBot/0.1.175 Chrome/146.0.7680.165 Electron/43.7.9 Safari/537.36";
const NATIVE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.165 Electron/43.7.9 Safari/537.36";
const CLEANED = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.165 Safari/537.36";

test("by default a pane is Electron's own Chromium: only the app's token goes, Electron's and the real Chrome version stay", () => {
  assert.equal(paneBaseUserAgent(ELECTRON, "native"), NATIVE);
  assert.equal(paneBaseUserAgent(ELECTRON, undefined), NATIVE);
  assert.equal(paneIdentityMode("anything else"), "native");
  assert.equal(withoutAppToken(ELECTRON.replace("OpenMausBot/0.1.175", "MausBot/0.2.0 Extra/1")), NATIVE);
  assert.equal(paneBaseUserAgent(ELECTRON, "cleaned"), CLEANED);
});

test("Google's sign-in hosts always see Electron's own UA, their subresources too, in either mode", () => {
  for (const mode of ["native", "cleaned"]) {
    assert.equal(paneRequestUserAgent(ELECTRON, mode, { url: "https://accounts.google.com/v3/signin/identifier", resourceType: "mainFrame" }), NATIVE);
    assert.equal(paneRequestUserAgent(ELECTRON, mode, { url: "https://accounts.youtube.com/accounts/SetSID", resourceType: "subFrame" }), NATIVE);
    assert.equal(paneRequestUserAgent(ELECTRON, mode, { url: "https://ssl.gstatic.com/x.js", referrer: "https://accounts.google.com/", resourceType: "script" }), NATIVE);
  }
  // A navigation away from sign-in, referred by it, is the site's own again.
  assert.equal(paneRequestUserAgent(ELECTRON, "cleaned", { url: "https://example.com/", referrer: "https://accounts.google.com/", resourceType: "mainFrame" }), CLEANED);
  assert.equal(paneRequestUserAgent(ELECTRON, "native", { url: "https://mail.google.com/", resourceType: "mainFrame" }), NATIVE);
});

test("Teams' request header drops Electron's token, its page keeps it; Chase gets a Chrome-shaped tab", () => {
  for (const host of ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) {
    assert.equal(paneRequestUserAgent(ELECTRON, "native", { url: `https://${host}/v2/`, resourceType: "mainFrame" }), CLEANED);
    assert.equal(paneTabUserAgent(ELECTRON, "native", `https://${host}/v2/`), NATIVE);
  }
  assert.equal(paneRequestUserAgent(ELECTRON, "native", { url: "https://secure.chase.com/web/auth", resourceType: "mainFrame" }), CLEANED);
  assert.equal(paneTabUserAgent(ELECTRON, "native", "https://www.chase.com/"), CLEANED);
  assert.equal(paneTabUserAgent(ELECTRON, "native", "https://notchase.com/"), NATIVE);
  assert.equal(paneTabUserAgent(ELECTRON, "native", "https://example.com/"), NATIVE);
});

test("the rules are data: three sites, each with its reason, and nothing else", () => {
  assert.deepEqual(PANE_IDENTITY_RULES.map((rule) => [rule.hosts.join(","), rule.identity, rule.where]), [
    ["accounts.google.com,accounts.youtube.com", "electron", "request"],
    ["teams.microsoft.com,teams.live.com,teams.cloud.microsoft", "no-electron-token", "request"],
    ["chase.com", "chrome-shaped", "tab"],
  ]);
  assert.ok(Object.isFrozen(PANE_IDENTITY_RULES));
});

test("no identity is invented: no other browser's UA, no Chrome brand, no automation switch or script in the pane's code", () => {
  for (const file of ["./browser-pane-identity.mjs", "./browser-pane-main.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const banned of [/Firefox/i, /Gecko\/\d/, /AutomationControlled/, /navigator\.webdriver/, /"Google Chrome"/, /userAgentFallback/, /appendSwitch/, /remote-debugging/, /executeJavaScript/, /sec-ch-ua/i]) {
      assert.doesNotMatch(source, banned, `${file} must not contain ${banned}`);
    }
  }
});
