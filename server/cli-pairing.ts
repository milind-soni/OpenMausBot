// What `openmausbot serve` and `openmausbot pair` print for a pairing code. A browser on this computer is no longer the
// owner just by being here, so it signs in once with the link printed for it.
import qrcode from "qrcode-terminal";

import { cliCommand } from "./cli-invocation.ts";

/** A clock time a code works until: "11:22", or "tomorrow 11:22" / a date when it runs past today. */
export function untilText(expiresAt: number, now = Date.now()): string {
  const end = new Date(expiresAt);
  const time = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  if (end.toDateString() === today.toDateString()) return time;
  const tomorrow = new Date(now + 86_400_000);
  return end.toDateString() === tomorrow.toDateString() ? `tomorrow ${time}` : `${end.toLocaleDateString()} ${time}`;
}

/**
 * What `serve` and `pair` print for one pairing code. `link`: the address other devices reach this server at, with the
 * code (null when it has no way in); `localLink`: a browser on this machine (or the Docker host, `localPlace`);
 * `inviteUrl`: the phone-app link only Android's scanner needs; `prefix`: how the CLI was started, so commands paste.
 */
export function pairingBlock(input: {
  code: string;
  expiresAt: number;
  chatOnly: boolean;
  link: string | null;
  localLink?: string | null;
  localPlace?: "machine" | "docker";
  inviteUrl?: string | null;
  phone?: "ios" | "android";
  prefix: string;
  now?: number;
}): string {
  const scope = input.chatOnly ? "chat and approvals" : "everything";
  const lines = [`Pairing code   ${input.code}   works once, until ${untilText(input.expiresAt, input.now)} · ${scope}`];
  if (!input.link) {
    lines.push("This server is reachable from this machine only, so there's no link for other devices.");
    if (input.localLink) lines.push(`  ${input.localPlace === "docker" ? "Browser on the Docker host" : "Browser on this machine  "}   ${input.localLink}`);
    lines.push(`  Other devices               pick a way in first: ${input.prefix} serve --help`);
    return lines.join("\n");
  }
  const scanInvite = input.phone === "android" && Boolean(input.inviteUrl);
  lines.push(`Link           ${input.link}`);
  lines.push("");
  lines.push("  Desktop app   ＋ → Connect to a server, paste the link");
  lines.push(scanInvite ? "  Phone         scan this with the MausBot app" : "  Phone         scan with your camera or the MausBot app");
  lines.push("");
  lines.push(qrToString(scanInvite ? input.inviteUrl! : input.link));
  if (!input.chatOnly) lines.push(`For a phone (chat and approvals only)   ${input.prefix} pair --phone`);
  return lines.join("\n");
}

/** The guided start's one sign-in, for the browser it opens on this computer. */
export function browserSignInLines(localUrl: string, code: string, expiresAt: number): string {
  return [
    "Sign in from a browser on this computer with this link (single use, until",
    `${new Date(expiresAt).toLocaleTimeString()}): ${localUrl}`,
    `or type the code ${code} on the sign-in page. Later: ${cliCommand("pair")}`,
  ].join("\n");
}

export function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out;
}

export function formatSessions(sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number; token?: true }>, now = Date.now()): string {
  const age = (ms: number) => {
    const m = Math.max(0, Math.floor((now - ms) / 60_000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const rows = sessions.map((s) => [s.id, `${s.label || "(unnamed)"}${s.token ? " (token)" : ""}`, s.scopes.includes("admin") ? "admin" : "client", age(s.lastSeenAt), new Date(s.expiresAt).toISOString().slice(0, 10)]);
  const head = ["id", "device", "scope", "last seen", "expires"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(head), ...rows.map(line), "", `sign one out with: ${cliCommand("devices revoke <id>")}`].join("\n");
}
