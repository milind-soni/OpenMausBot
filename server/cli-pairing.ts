// What `openmausbot serve` and `openmausbot pair` print for a pairing code. A browser on this computer is no longer the
// owner just by being here, so it signs in once with the link printed for it.
import qrcode from "qrcode-terminal";

import { cliCommand } from "./cli-invocation.ts";
import type { PhoneRelayStatus } from "./phone-relay.ts";

/** The desktop app owns this server, so only the app (or a paired device) may mint a code: say where pairing works instead. */
export function desktopOwnedRefusal(status: number, body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (status !== 403 || typeof error !== "string" || !error.includes("must come from the desktop app")) return null;
  return `The OpenMausBot desktop app runs this server, so it only pairs devices from the app itself: open OpenMausBot on this computer and use Settings → Remote access. To pair from this terminal instead, quit the desktop app and start the server with ${cliCommand("serve")}.`;
}

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

const isStatus = (value: unknown): value is PhoneRelayStatus =>
  typeof value === "object" && value !== null && typeof (value as PhoneRelayStatus).grant === "string" && typeof (value as PhoneRelayStatus).relay === "string";

/** Until the control plane tells a server from a desktop, a machine that takes a relay token gives back its tunnel. */
export const RELAY_NOT_WITH_TUNNEL = "--relay cannot be used on a machine whose saved choice is a tunnel address: a relay token would make the tunnel go for good. Start with --local, or use the relay on a machine signed in with `openmausbot login --relay`.";

/** Why phones cannot pair through the relay yet, in words for the person at the terminal; empty when they can. */
export function relayProblemLines(status: PhoneRelayStatus | null, prefix: string): string[] {
  if (!status) return [`MausBot Relay is off on this server. Start it with: ${prefix} serve --relay`];
  if (status.grant === "tunnel") return [`MausBot Relay stays off here: ${status.reason ?? "this machine holds a tunnel address"}. A relay token would make that tunnel go for good; use the relay on a machine signed in with ${prefix} login --relay.`];
  if (status.grant === "signed-out") return [`MausBot Relay needs this machine signed in to a MausBot account: ${prefix} login --relay (then leave the server running; it connects within a minute).`];
  if (status.grant === "unavailable") return ["MausBot Relay is not available for this machine right now. The server keeps working here; it asks again every half hour."];
  if (status.grant === "failed") return ["The MausBot account service did not answer. The server keeps working here and keeps trying."];
  if (status.grant === "waiting") return ["Still asking the MausBot account service for a relay pass…"];
  if (status.relay !== "connected") return ["Can't reach MausBot Relay yet. The server keeps working here and keeps trying; phones pair once it connects."];
  return [];
}

/** The relay block for a phone code, or null when the server did not answer with a relay link. */
export function relayPairingBlock(body: Record<string, unknown>, chatOnly: boolean, prefix: string, now = Date.now()): string | null {
  const invite = typeof body.inviteUrl === "string" && body.inviteUrl.includes("&e2e=") ? body.inviteUrl : null;
  if (!chatOnly || !isStatus(body.relay) || !invite || typeof body.expiresAt !== "number") return null;
  const lines = [
    `Phone pairing   works once, until ${untilText(body.expiresAt, now)} · chat and approvals`,
    "  Scan with the MausBot app. It connects through MausBot Relay, end-to-end encrypted: no address, open port or VPN needed.",
    "",
    qrToString(invite),
    ...relayProblemLines(body.relay, prefix),
    `Paired phones: ${body.relay.phones} of ${body.relay.maxPhones}. Remove one: ${prefix} devices revoke ID`,
  ];
  return lines.join("\n");
}

/** Waits for the relay to connect, then prints a phone code; otherwise says why not. True when it printed a code. A
 * service's output lands in its log on every start, so the one-time credential is printed only at a terminal. */
export async function showRelayPairing(input: {
  tty: boolean;
  status: () => Promise<unknown>;
  mint: () => Promise<string>;
  log: (line: string) => void;
  prefix: string;
  waitMs?: number;
}): Promise<boolean> {
  if (!input.tty) {
    input.log(`Pair a phone: ${input.prefix} pair --phone`);
    return false;
  }
  const deadline = Date.now() + (input.waitMs ?? 20_000);
  let status: PhoneRelayStatus | null = null;
  for (;;) {
    const read = await input.status().catch(() => null);
    status = isStatus(read) ? read : null;
    if (!status || (status.grant === "ok" && status.relay === "connected") || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (status?.grant === "ok") {
    input.log(await input.mint());
    return true;
  }
  for (const line of relayProblemLines(status, input.prefix)) input.log(line);
  if (status?.grant !== "tunnel") input.log(`Then: ${input.prefix} pair --phone`);
  return false;
}
