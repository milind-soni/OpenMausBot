// The name a first run greets someone by when their profile has none: the full name on this computer's own account.
import { execFile } from "node:child_process";
import os from "node:os";

const NOT_A_NAME = new Set(["admin", "administrator", "user", "guest", "student", "owner", "root", "test"]);

/** An account's full name worth greeting someone by, or null: never the login's short name, an address, a value with
 * digits or a generic account name. The first part before a comma (GECOS), kept to the profile's 100 characters. */
export function systemFullName(full, login) {
  const name = String(full ?? "").split(",")[0].trim().slice(0, 100);
  if (!name || name.includes("@") || /\d/.test(name)) return null;
  const lower = name.toLowerCase();
  return NOT_A_NAME.has(lower) || lower === String(login ?? "").trim().toLowerCase() ? null : name;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2_000, encoding: "utf8", windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

/** macOS's `id -F`, Linux's GECOS field from `getent passwd <uid>`; Windows gives none. */
export async function accountFullName({ platform = process.platform, user = os.userInfo(), exec = run } = {}) {
  if (platform === "darwin") return systemFullName((await exec("/usr/bin/id", ["-F"])).trim(), user.username);
  if (platform !== "linux" || typeof user.uid !== "number" || user.uid < 0) return null;
  const entry = (await exec("getent", ["passwd", String(user.uid)])).trim();
  return systemFullName(entry.split(":")[4] ?? "", user.username);
}
