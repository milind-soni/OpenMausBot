import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

// Installs a downloaded .deb behind one polkit prompt. Root copies the file to a root-only dir and checks the feed's SHA-512 before apt-get sees it,
// so a file swapped in the user-writable cache after the download is refused. Only this fixed script runs as root, never renderer text.

// pkexec is only trusted at its system location, not wherever PATH finds one.
export const PKEXEC = "/usr/bin/pkexec";
const SHELL = "/bin/sh";
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

// $1: the staged .deb, $2: its expected SHA-512 as lowercase hex.
export const ELEVATED_INSTALL_SCRIPT = `set -eu
umask 077
export DEBIAN_FRONTEND=noninteractive
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -- "$1" "$dir/update.deb"
actual=$(sha512sum "$dir/update.deb" | cut -d ' ' -f 1)
if [ "$actual" != "$2" ]; then
  echo "the downloaded package does not match its checksum" >&2
  exit 65
fi
chmod 0755 "$dir"
chmod 0644 "$dir/update.deb"
apt-get install -y -o Dpkg::Options::=--force-confold "$dir/update.deb"
`;

// pkexec exit codes: the dialog was dismissed, or authorization failed (also: no polkit agent in this session).
const PKEXEC_DISMISSED = 126;
const PKEXEC_NOT_AUTHORIZED = 127;
const CHECKSUM_MISMATCH = 65;

// `OMB_UPDATE_INSTALL=terminal` opts out.
export function canInstallElevated({
  platform = process.platform,
  env = process.env,
  pkexec = PKEXEC,
  access = accessSync,
} = {}) {
  if (platform !== "linux") return false;
  if (env.OMB_UPDATE_INSTALL === "terminal") return false;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  try {
    access(pkexec, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// electron-updater records the SHA-512 as base64 (a feed may carry hex); the script compares lowercase hex.
export function sha512Hex(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^[0-9a-f]{128}$/i.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  return Buffer.from(value, "base64").toString("hex");
}

function lastLine(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.slice(0, 200) ?? "";
}

// Never throws. Resolves { ok: true } or { ok: false, reason, detail }, reason one of:
// unverifiable (no file, not a .deb, no checksum), unavailable (no pkexec), declined (prompt closed),
// refused (polkit said no), checksum (file changed since download), failed (apt-get or the script; detail is its last line).
export function installPackageElevated({
  file,
  sha512,
  pkexec = PKEXEC,
  run = execFile,
  stat = lstatSync,
  timeout = INSTALL_TIMEOUT_MS,
} = {}) {
  const expected = sha512Hex(sha512);
  let regular = false;
  try {
    regular = typeof file === "string" && stat(file).isFile();
  } catch {
    regular = false;
  }
  if (typeof file !== "string" || !isAbsolute(file) || !file.endsWith(".deb") || !regular) {
    return Promise.resolve({
      ok: false,
      reason: "unverifiable",
      detail: "The downloaded package is no longer available. Try the update again.",
    });
  }
  if (!expected) {
    return Promise.resolve({
      ok: false,
      reason: "unverifiable",
      detail: "The update feed gave no checksum to verify the package against.",
    });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = run(
        pkexec,
        [SHELL, "-c", ELEVATED_INSTALL_SCRIPT, "sh", file, expected],
        { timeout, killSignal: "SIGTERM" },
        (error, _stdout, stderr) => {
          if (!error) return resolve({ ok: true });
          if (error.code === "ENOENT") {
            return resolve({ ok: false, reason: "unavailable", detail: "pkexec is not installed." });
          }
          if (error.code === PKEXEC_DISMISSED) {
            return resolve({ ok: false, reason: "declined", detail: "The password prompt was closed." });
          }
          if (error.code === PKEXEC_NOT_AUTHORIZED) {
            return resolve({ ok: false, reason: "refused", detail: "This session could not ask for administrator rights." });
          }
          if (error.code === CHECKSUM_MISMATCH) {
            return resolve({
              ok: false,
              reason: "checksum",
              detail: "The downloaded update did not match its checksum. Check again to download it fresh.",
            });
          }
          const reason = error.killed ? "The install took too long." : lastLine(stderr) || error.message;
          resolve({ ok: false, reason: "failed", detail: `The install did not finish: ${reason}`.slice(0, 240) });
        },
      );
    } catch (error) {
      resolve({ ok: false, reason: "unavailable", detail: String(error?.message ?? error) });
      return;
    }
    child?.stdin?.end?.();
  });
}
