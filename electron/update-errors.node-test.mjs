import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { updateErrorMessage, updateErrorNeedsPerson } from "./update-errors.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

test("update failures keep integrity and certificate errors distinct from recoverable environment errors", () => {
  for (const [message, expected] of [
    ["sha512 checksum mismatch; ENOSPC", /failed verification/],
    ["code signature is invalid", /failed verification/],
    ["ENOSPC: write failed", /Free some space/],
    ["EPERM: unlink C:\\Users\\test\\cache.zip", /permissions/],
    ["Read-only file system", /permissions/],
    ["EBUSY: rename", /file is in use/],
    ["net::ERR_CERT_AUTHORITY_INVALID", /do not disable certificate checks/],
    ["Cannot find latest-mac.yml: 404", /missing or invalid/],
    ["HTTP 503 Service Unavailable", /connection and try again/],
    ["ETIMEDOUT", /connection and try again/],
  ]) assert.match(updateErrorMessage(new Error(message)), expected);
  assert.match(updateErrorMessage(Object.assign(new Error("écriture impossible"), { code: "ENOSPC" })), /Free some space/);
  assert.match(updateErrorMessage(Object.assign(new Error("connection failed"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })), /do not disable certificate checks/);
  assert.match(updateErrorMessage(Object.assign(new Error('publisherNames differ. SignerCertificate: {"Subject":"CN=Unexpected"}'), { code: "ERR_UPDATER_INVALID_SIGNATURE" })), /failed verification/);
  assert.match(updateErrorMessage(new Error('ERR_UPDATER_INVALID_SIGNATURE: SignerCertificate mismatch')), /failed verification/);
  assert.equal(updateErrorMessage(new Error("unknown failure")), "unknown failure");
});

test("only failures the person must fix are theirs to see when nobody asked", () => {
  for (const message of ["sha512 checksum mismatch", "code signature is invalid", "ENOSPC: write failed", "EPERM: unlink C:\\cache.zip", "EBUSY: rename"]) {
    assert.equal(updateErrorNeedsPerson(new Error(message)), true, message);
  }
  assert.equal(updateErrorNeedsPerson(Object.assign(new Error("sha512 mismatch"), { code: "ERR_UPDATER_CHECKSUM_MISMATCH" })), true);
  for (const message of ["ETIMEDOUT", "ECONNRESET", "HTTP 503 Service Unavailable", "net::ERR_INTERNET_DISCONNECTED", "Cannot find latest-mac.yml: 404", "net::ERR_CERT_AUTHORITY_INVALID", "unknown failure"]) {
    assert.equal(updateErrorNeedsPerson(new Error(message)), false, message);
  }
});

test("a server error wrapped with the release feed is a network failure, whatever the release notes say", () => {
  // electron-updater wraps a failed GitHub request in "Cannot parse releases feed" and appends the whole feed, release notes included.
  const feed = '<?xml version="1.0"?><feed><entry><content>Fix Gemini thought signature and certificate handling; checksum 404 cleanup</content></entry></feed>';
  const error = Object.assign(
    new Error(`Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: HttpError: 504 Gateway Time-out\n"<html>The server didn't respond in time.</html>"\nHeaders: {}\n    at createHttpError (builder-util-runtime/out/httpExecutor.js:20:12),\nXML:\n${feed}`),
    { code: "ERR_UPDATER_INVALID_RELEASE_FEED" },
  );
  assert.equal(updateErrorNeedsPerson(error), false);
  assert.match(updateErrorMessage(error), /connection and try again/);
  // the server's own error page may mention a signature too
  const page = Object.assign(new Error(`Cannot parse releases feed: Error: Unable to find latest version on GitHub: HttpError: 502 Bad Gateway\n"<html>upstream signature check timed out</html>"\nXML:\n${feed}`), { code: "ERR_UPDATER_INVALID_RELEASE_FEED" });
  assert.equal(updateErrorNeedsPerson(page), false);
  assert.match(updateErrorMessage(page), /connection and try again/);
  const brokenFeed = Object.assign(new Error(`Cannot parse releases feed: TypeError: Cannot read properties of null,\nXML:\n${feed}`), { code: "ERR_UPDATER_INVALID_RELEASE_FEED" });
  assert.equal(updateErrorNeedsPerson(brokenFeed), false);
  assert.match(updateErrorMessage(brokenFeed), /missing or invalid/);
});

test("actionable messages do not permit retrying failed native staging", async () => {
  const updater = new EventEmitter();
  let state = {};
  let downloads = 0;
  let installs = 0;
  const coordinator = createUpdaterCoordinator(updater, (patch) => { state = { ...state, ...patch }; }, { nativeStaging: true });
  updater.downloadUpdate = async () => {
    downloads++;
    updater.emit("update-downloaded", { version: "2.0.0" });
    const error = Object.assign(new Error("write failed"), { code: "ENOSPC" });
    updater.emit("error", error);
    throw error;
  };
  updater.quitAndInstall = () => { installs++; };
  updater.checkForUpdates = async () => { updater.emit("update-available", { version: "2.0.0" }); };
  await coordinator.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.retryable, false);
  assert.match(state.message, /Free some space.*Quit and reopen/);
  assert.equal(state.messageCode, "disk", "the window says it in its own language");
  await coordinator.check(true);
  coordinator.install();
  assert.equal(downloads, 1);
  assert.equal(installs, 0);
});
