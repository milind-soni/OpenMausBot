// Keep platform error details in the updater log; show the same recovery
// guidance in Settings and the update card. This never relaxes install locks.
export function updateErrorMessage(error) {
  const message = String(error?.message ?? error ?? "Update failed");
  const detail = `${error?.code ?? ""} ${message}`;
  // Installer errors may include SignerCertificate details. Those must not
  // become network advice just because their diagnostic mentions certificates.
  const integrity = /ERR_UPDATER_(?:INVALID_SIGNATURE|CHECKSUM_MISMATCH)/i.test(detail);
  const tls = /CERT_|ERR_TLS_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SSL_ERROR|SELF_SIGNED_CERT_IN_CHAIN/i.test(detail);
  if (!integrity && tls) {
    return "The update connection could not be verified. Check your clock, VPN or proxy; do not disable certificate checks.";
  }
  // Integrity failures must never be explained away as a network/disk issue.
  if (integrity || /checksum|signature|codesign/i.test(detail)) {
    return "The update failed verification. Download a fresh installer from the official release page.";
  }
  if (/\bENOSPC\b|no space left|disk (?:is )?full/i.test(detail)) {
    return "Not enough disk space to prepare the update. Free some space, then try again.";
  }
  if (/\b(?:EACCES|EPERM)\b|read.only (?:volume|file system)|permission denied|access is denied/i.test(detail)) {
    return "The update could not write to the app or its cache. Check folder permissions, or use the official installer.";
  }
  if (/\bEBUSY\b|being used by another process/i.test(detail)) {
    return "An update file is in use. Close other copies of OpenMausBot, then try again.";
  }
  if (/certificate/i.test(detail)) {
    return "The update connection could not be verified. Check your clock, VPN or proxy; do not disable certificate checks.";
  }
  if (/\b404\b|cannot find .*\.yml|cannot parse update info|no files provided|ERR_UPDATER_INVALID_RELEASE_FEED/i.test(detail)) {
    return "The update files are missing or invalid. Check the official release page, or try again later.";
  }
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|net::ERR_|\bHTTP[^\n]*\b5\d\d\b|status(?: code)?[: ]+5\d\d\b/i.test(detail)) {
    return "The update download was interrupted or the server is unavailable. Check your connection and try again.";
  }
  return message;
}
