// Linux: ufw turned on with its default "deny incoming" drops a phone's connection to the device port, and nothing
// on the phone can tell that from a computer that is off. This only reads the files ufw keeps under /etc, so the
// pairing panel can say what to allow. It never runs `ufw status` (that needs root) and never changes anything.
import { readFileSync } from "node:fs";

export type HostFirewall = "ufw";

const UFW_CONF = "/etc/ufw/ufw.conf";
const UFW_DEFAULTS = "/etc/default/ufw";
/** World-readable on some distributions, 0640 root on others: unreadable means "can't tell". */
const UFW_USER_RULES = "/etc/ufw/user.rules";

/** `ENABLED=yes`: ufw starts at boot (`ufw enable` writes it). */
export function ufwEnabled(conf: string | null): boolean {
  return /^[ \t]*ENABLED[ \t]*=[ \t]*["']?yes["']?[ \t]*$/im.test(conf ?? "");
}

/** `DEFAULT_INPUT_POLICY` is DROP or REJECT. Unset or unreadable counts as dropping: that is ufw's own default. */
export function ufwDropsIncoming(defaults: string | null): boolean {
  const policy = /^[ \t]*DEFAULT_INPUT_POLICY[ \t]*=[ \t]*["']?([A-Za-z]+)/m.exec(defaults ?? "")?.[1];
  return policy?.toUpperCase() !== "ACCEPT";
}

const portListed = (ports: string, port: number): boolean =>
  ports === "any" ||
  ports.split(",").some((part) => {
    const [low, high] = part.split(":").map(Number);
    return high === undefined ? low === port : low <= port && port <= high;
  });

/**
 * Whether a rule in user.rules lets TCP in on `port`, from its `### tuple ###` lines: action, protocol, destination
 * port, destination, source port, source, [two application names,] and the direction last (`in`, `in_wlan0`). A rule
 * limited to some sources still counts: this only decides whether to show a hint. Null when the rules can't be read.
 */
export function ufwAllowsPort(rules: string | null, port: number): boolean | null {
  if (rules === null) return null;
  return rules.split(/\r?\n/).some((line) => {
    const tuple = /^### tuple ###\s*(.*)$/.exec(line)?.[1]?.split(" comment=")[0]?.trim();
    if (!tuple) return false;
    const fields = tuple.split(/\s+/);
    if (fields.length !== 7 && fields.length !== 9) return false;
    const [action, protocol, ports] = fields;
    const direction = fields[fields.length - 1];
    return /^(allow|limit)(_log(-all)?)?$/.test(action) &&
      (protocol === "tcp" || protocol === "any") &&
      (direction === "in" || direction.startsWith("in_")) &&
      portListed(ports, port);
  });
}

type ReadText = (path: string) => string | null;

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** "ufw" when ufw is on, drops what it wasn't told to let in, and no rule it lets us read allows `port`. */
export function ufwBlocksPort(port: number, read: ReadText = readText): boolean {
  if (!ufwEnabled(read(UFW_CONF)) || !ufwDropsIncoming(read(UFW_DEFAULTS))) return false;
  return ufwAllowsPort(read(UFW_USER_RULES), port) !== true;
}

/** How old an answer may be: someone who runs the allow command sees the hint go within this long. */
const MAX_AGE_MS = 10_000;

/** Three small file reads at most every ten seconds, only on Linux; null elsewhere and whenever it can't tell. */
export function createHostFirewallCheck({
  platform = process.platform,
  read = readText,
  now = Date.now,
  maxAgeMs = MAX_AGE_MS,
}: {
  platform?: NodeJS.Platform;
  read?: ReadText;
  now?: () => number;
  maxAgeMs?: number;
} = {}): (port: number) => HostFirewall | null {
  let known: { port: number; at: number; answer: HostFirewall | null } | null = null;
  return (port) => {
    if (platform !== "linux") return null;
    if (known && known.port === port && now() - known.at < maxAgeMs) return known.answer;
    const answer = ufwBlocksPort(port, read) ? "ufw" : null;
    known = { port, at: now(), answer };
    return answer;
  };
}

export const hostFirewall = createHostFirewallCheck();
