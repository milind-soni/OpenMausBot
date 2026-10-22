export const UPDATE_TEXT = Object.freeze({
  tls: "The update connection could not be verified. Check your clock, VPN or proxy; do not disable certificate checks.",
  integrity: "The update failed verification. Download a fresh installer from the official release page.",
  disk: "Not enough disk space to prepare the update. Free some space, then try again.",
  permission: "The update could not write to the app or its cache. Check folder permissions, or use the official installer.",
  busy: "An update file is in use. Close other copies of OpenMausBot, then try again.",
  feed: "The update files are missing or invalid. Check the official release page, or try again later.",
  network: "The update download was interrupted or the server is unavailable. Check your connection and try again.",
  prepareTimeout: "Preparing the update took too long.",
  slowRestart: "Restart is taking longer than expected. Quit and reopen OpenMausBot to finish the update.",
  unavailable: "updater unavailable",
});
const NEEDS_PERSON = new Set(["integrity", "disk", "permission", "busy"]);

export function updateErrorNeedsPerson(error) {
  return NEEDS_PERSON.has(updateErrorCode(error));
}

export function updateErrorCode(error) {
  const message = String(error?.message ?? error ?? "Update failed");
  const detail = `${error?.code ?? ""} ${message}`;
  // Installer errors may mention SignerCertificate details; that must not read as network advice.
  const integrity = /ERR_UPDATER_(?:INVALID_SIGNATURE|CHECKSUM_MISMATCH)/i.test(detail);
  const tls = /CERT_|ERR_TLS_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SSL_ERROR|SELF_SIGNED_CERT_IN_CHAIN/i.test(detail);
  if (!integrity && tls) return "tls";
  // Integrity failures must never be explained away as a network/disk issue.
  if (integrity || /checksum|signature|codesign/i.test(detail)) return "integrity";
  if (/\bENOSPC\b|no space left|disk (?:is )?full/i.test(detail)) return "disk";
  if (/\b(?:EACCES|EPERM)\b|read.only (?:volume|file system)|permission denied|access is denied/i.test(detail)) return "permission";
  if (/\bEBUSY\b|being used by another process/i.test(detail)) return "busy";
  if (/certificate/i.test(detail)) return "tls";
  if (/\b404\b|cannot find .*\.yml|cannot parse update info|no files provided|ERR_UPDATER_INVALID_RELEASE_FEED/i.test(detail)) return "feed";
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|net::ERR_|\bHTTP[^\n]*\b5\d\d\b|status(?: code)?[: ]+5\d\d\b/i.test(detail)) return "network";
  if (message === UPDATE_TEXT.prepareTimeout) return "prepareTimeout";
  return null;
}

export function updateErrorMessage(error) {
  const code = updateErrorCode(error);
  return code ? UPDATE_TEXT[code] : String(error?.message ?? error ?? "Update failed");
}
