// What `openmausbot serve` and `openmausbot pair` print for a pairing code. A browser on this computer is no longer the
// owner just by being here, so it signs in once with the link printed for it.
import qrcode from "qrcode-terminal";

/** `url` opens the web app (browsers, the iOS app); `inviteUrl` (openmausbot://) is the only thing the Android app scans;
 * `localUrl` signs in a browser on this computer. */
export function pairingBlock(input: {
  code: string;
  url: string | null;
  inviteUrl?: string | null;
  localUrl?: string | null;
  expiresAt: number;
  hint?: string | null;
  phone?: "ios" | "android";
}): string {
  const expires = new Date(input.expiresAt);
  const when = input.expiresAt - Date.now() > 12 * 3_600_000 ? expires.toLocaleString() : expires.toLocaleTimeString();
  const lines = [`pairing code:  ${input.code}`, `expires:       ${when} (single use)`];
  if (input.localUrl) lines.push(`this computer: ${input.localUrl}`);
  if (!input.url && !input.inviteUrl) {
    lines.push(`open:          /pair on the address you use for this server, and type the code`);
    if (input.hint) lines.push(`               (${input.hint})`);
    return lines.join("\n");
  }
  const scanInvite = input.phone === "android" && !!input.inviteUrl;
  if (input.url) lines.push(scanInvite ? `web browser:   ${input.url}` : `open or scan:  ${input.url}`);
  if (input.inviteUrl) lines.push(`phone app:     ${input.inviteUrl}`);
  const target = scanInvite ? input.inviteUrl! : input.url;
  if (target) {
    lines.push("");
    lines.push(qrToString(target));
    lines.push("");
    if (scanInvite) {
      lines.push(`Scan that in the OpenMausBot app. For a browser instead, open the web`);
      lines.push(`address above and type the code.`);
    } else if (input.phone === "android") {
      lines.push(`That QR opens the web app. The Android app needs the phone-app link,`);
      lines.push(`which this server cannot build without a public address: set`);
      lines.push(`OMB_PUBLIC_URL, or open the web address above and type the code.`);
    } else if (input.inviteUrl) {
      lines.push(`Scan that with Camera for the browser, or paste the phone-app link`);
      lines.push(`above into the OpenMausBot app.`);
    }
  }
  return lines.join("\n");
}

/** The guided start's one sign-in, for the browser it opens on this computer. */
export function browserSignInLines(localUrl: string, code: string, expiresAt: number): string {
  return [
    "Sign in from a browser on this computer with this link (single use, until",
    `${new Date(expiresAt).toLocaleTimeString()}): ${localUrl}`,
    `or type the code ${code} on the sign-in page. Later: openmausbot pair`,
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
  return [line(head), ...rows.map(line), "", "revoke one with: openmausbot sessions revoke <id>"].join("\n");
}
