import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { updateErrorMessage } from "./update-errors.mjs";
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
  await coordinator.download();
  assert.equal(state.retryable, false);
  assert.match(state.message, /Free some space.*Quit and reopen/);
  await coordinator.download();
  coordinator.install();
  assert.equal(downloads, 1);
  assert.equal(installs, 0);
});
