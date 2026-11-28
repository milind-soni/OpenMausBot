// Security: what a self-hosted owner may open from outside a conversation's workspace when a bot links it. The bot picks
// the path and the server reads it with its own rights, so a boxed or prompt-injected bot must not be able to hand the
// owner a secret it cannot read itself. Every check runs on the resolved path (and on the link as written).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

export interface OutsideFilePlace {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

/** The home folder as resolved paths spell it (macOS's /var is /private/var). */
function resolvedHome(): string {
  try { return realpathSync(homedir()); } catch { return homedir(); }
}

const here = (): OutsideFilePlace => ({ home: resolvedHome(), platform: process.platform, env: process.env });

/** Names that hold keys or credentials wherever they sit. */
const SECRET_NAME = /^(?:id_(?:rsa|ed25519|ecdsa|dsa)|credentials)|\.(?:pem|key|p12|pfx|p8|kdbx|kdb|ppk|jks|keystore|asc|gpg|env)$/i;

/** Browser profile folders under macOS's Application Support; each holds cookies, saved passwords and session tokens. */
const MAC_BROWSERS = [
  "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "BraveSoftware", "Microsoft Edge", "Firefox",
  "Arc", "Vivaldi", "com.operasoftware.Opera", "Orion", "Zen",
];

const segments = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean);
const lowered = (path: string, folds: boolean): string => {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return folds ? slashed.toLowerCase() : slashed;
};

/** Secret stores whose folders start with no dot, for this computer's platform. */
function secretStores({ home, platform, env }: OutsideFilePlace): string[] {
  if (platform === "darwin") {
    return [
      `${home}/Library/Keychains`, "/Library/Keychains", `${home}/Library/Cookies`,
      ...MAC_BROWSERS.map((browser) => `${home}/Library/Application Support/${browser}`),
    ];
  }
  if (platform === "win32") {
    const roaming = env.APPDATA || `${home}\\AppData\\Roaming`;
    const local = env.LOCALAPPDATA || `${home}\\AppData\\Local`;
    return [
      `${roaming}\\Microsoft\\Credentials`, `${roaming}\\Microsoft\\Protect`, `${local}\\Microsoft\\Credentials`,
      `${local}\\Microsoft\\Vault`, `${roaming}\\Microsoft\\Vault`, `${roaming}\\Mozilla\\Firefox\\Profiles`,
      `${roaming}\\Opera Software`,
    ];
  }
  return [];
}

/** True when this path must not be opened: a hidden file or folder anywhere on it, a known secret store, or a name that
 * looks like a key or credential. Folding case where the file system does. */
export function outsideFileRefused(path: string, place: OutsideFilePlace = here()): boolean {
  const parts = segments(path);
  if (parts.some((part) => part.startsWith("."))) return true;
  const name = parts.at(-1) ?? "";
  if (SECRET_NAME.test(name)) return true;
  const folds = place.platform === "darwin" || place.platform === "win32";
  // Chromium-family browsers on Windows keep every profile under a "User Data" folder.
  if (place.platform === "win32" && parts.some((part) => part.toLowerCase() === "user data")) return true;
  const target = lowered(path, folds);
  return secretStores(place).some((store) => {
    const root = lowered(store, folds);
    return target === root || target.startsWith(`${root}/`);
  });
}
