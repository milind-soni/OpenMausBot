// Pairing codes: the link/QR block, phone pairing presentation, and `pair`.
import qrcode from "qrcode-terminal";

import { defaultSetupIo, SetupCancelled } from "../cli-prompts.ts";
import { normalizePhoneOrigin, phonePairingInstructions } from "../cli-phone-setup.ts";
import { createTunnelAccount, describeTunnelAccount } from "../tunnel.ts";
import { tailscaleStatus } from "../tailscale.ts";
import { api, serverUp, verifyPhoneEndpoint } from "./client.ts";
import { serverVersion, type CliOptions } from "./options.ts";
import { applyStartupPreferences } from "./prefs.ts";

export async function showPhonePairing(options: CliOptions, origin: string | undefined, log: (line: string) => void): Promise<boolean> {
  const ready = !!origin && await verifyPhoneEndpoint(options.port, origin);
  if (!ready) {
    log("Phone access is not reachable yet. Your local workspace is ready; no phone pairing code was created.");
    log("Check the HTTPS connection, then run openmausbot pair again with the same --data-dir and --port.");
    return false;
  }
  for (const line of phonePairingInstructions(options.phone ?? "ios", { origin: origin!, ready })) log(line);
  log(await mintPairing(options.port, { client: true, label: options.label ?? (options.phone === "android" ? "Android" : "iPhone / iPad"), publicUrl: origin, phone: options.phone }));
  log("Waiting for you to connect on the phone. Keep this terminal and the code private.");
  return true;
}

/** The pairing link a device opens, rendered as text and a QR code.
 *
 * One window has two links. `url` opens the web app and is what a browser and
 * the iOS app read. `inviteUrl` is the openmausbot:// scheme the native
 * companion scanners accept, and it is the ONLY thing an Android app can
 * scan — its parser rejects any https QR outright. Which one becomes the QR
 * therefore depends on which app is about to scan it; the other is still
 * printed as text so neither route is hidden. */
export function pairingBlock(input: {
  code: string;
  url: string | null;
  inviteUrl?: string | null;
  expiresAt: number;
  hint?: string | null;
  phone?: "ios" | "android";
}): string {
  const lines = [`pairing code:  ${input.code}`, `expires:       ${new Date(input.expiresAt).toLocaleTimeString()} (single use)`];
  if (!input.url && !input.inviteUrl) {
    lines.push(`open:          /pair on the address you use for this server, and type the code`);
    if (input.hint) lines.push(`               (${input.hint})`);
    return lines.join("\n");
  }
  // One QR, and it belongs to whichever app is about to scan it. Android's
  // scanner rejects an https payload outright, so an Android phone gets the
  // app-scheme invite; everyone else gets the web link, which Camera opens
  // and which the iOS app also accepts.
  const scanInvite = input.phone === "android" && !!input.inviteUrl;
  // Print every link this window has, and label them by what the QR below
  // actually encodes: "scan" belongs only to the link it is a picture of. A
  // link that is named but never shown is worse than one that is absent —
  // the iOS app takes a pasted invite, so the text form is the fallback when
  // a QR cannot be scanned off a terminal.
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
      // Android asked for an app invite this server cannot build. Say so,
      // rather than leave a QR its scanner will reject under instructions
      // telling someone to scan it.
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

/** The scheme and host of a link, or null if it is not one we can dial. */
function originOf(link: string): string | null {
  try {
    return new URL(link).origin;
  } catch {
    return null;
  }
}

export function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out;
}

export async function mintPairing(port: number, options: { label?: string; client?: boolean; publicUrl?: string; phone?: "ios" | "android" }): Promise<string> {
  const request: { label?: string; scopes?: string[] } = {};
  if (options.label) request.label = options.label;
  if (options.client) request.scopes = ["client"];
  const { status, body } = await api(port, "/api/auth/pairing", { method: "POST", body: JSON.stringify(request) });
  if (status !== 200) throw new Error(`server refused to mint a pairing code: ${typeof body?.error === "string" ? body.error : status}`);
  const url = options.publicUrl ? `${options.publicUrl}/pair#code=${body.code}` : typeof body.url === "string" ? body.url : null;
  // A server too old to mint a credential simply has no invite: the web link
  // still works, so an upgrade is never required to pair a browser.
  // The address the phone will dial. `--public-url` wins, exactly as it does
  // for the web link above: a server behind someone else's proxy often does
  // not know its own public name, which is what that flag is for. Gate on the
  // credential, never on the server's own invite — a server started without
  // OMB_PUBLIC_URL returns a credential and no invite, and gating on the
  // invite would throw away a secret the CLI has every part it needs to use.
  const address = options.publicUrl ?? (typeof body.url === "string" ? originOf(body.url) : null);
  // A server too old to mint a credential simply has no invite: the web link
  // still works, so an upgrade is never required to pair a browser.
  const invite = typeof body.credential === "string" && address
    ? `openmausbot://pair?address=${encodeURIComponent(address)}&token=${encodeURIComponent(body.credential)}${typeof body.serverName === "string" ? `&name=${encodeURIComponent(body.serverName)}` : ""}`
    : typeof body.inviteUrl === "string" ? body.inviteUrl : null;
  return pairingBlock({ code: body.code, url, inviteUrl: invite, expiresAt: body.expiresAt, hint: typeof body.hint === "string" ? body.hint : null, phone: options.phone });
}

// ── commands ───────────────────────────────────────────────────────────
export async function runPair(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) {
    console.error(`no OpenMausBot server on http://127.0.0.1:${options.port}; start one with \`openmausbot serve\` or set OMB_PORT`);
    return 1;
  }
  if (process.stdin.isTTY && process.stdout.isTTY && !options.label && !options.client) {
    const advertised = await api(options.port, "/api/auth/pairing");
    let launch = options;
    // The running server may use a one-time route override. Saved preferences
    // describe the next launch, not necessarily the address working now.
    let origin = options.publicUrl ?? (typeof advertised.body?.publicUrl === "string" ? advertised.body.publicUrl : undefined);
    if (!origin) {
      const { readCliStartup } = await import("../cli-setup.ts");
      launch = applyStartupPreferences(options, readCliStartup(options.dataDir));
      origin = launch.publicUrl;
      if (launch.tunnel) origin = describeTunnelAccount(createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() }).credentials.read()).address ?? undefined;
      if (launch.tailscale) {
        const status = await tailscaleStatus();
        if (!("failure" in status) && status.status.dnsName) origin = `https://${status.status.dnsName}`;
      }
    }
    if (!origin || !normalizePhoneOrigin(origin)) {
      console.log("Your workspace is running only on this computer. A phone cannot use its localhost address.");
      console.log("Stop the server, run openmausbot setup and choose phone access, then start openmausbot again.");
      return 1;
    }
    const ui = defaultSetupIo();
    try {
      const selected = await ui.choose("Which phone are you connecting?", ["iPhone / iPad — app or Safari", "Android — app or browser", "Cancel"], 0);
      if (selected === 2) return 0;
      launch = { ...launch, phone: selected === 0 ? "ios" : "android" };
      return await showPhonePairing(launch, origin, ui.log) ? 0 : 1;
    } catch (error) {
      if (!(error instanceof SetupCancelled)) throw error;
      console.log("Pairing cancelled. Existing devices are unchanged.");
      return 130;
    }
  }
  console.log(await mintPairing(options.port, { label: options.label, client: options.client, publicUrl: options.publicUrl, phone: options.phone }));
  if (options.client) console.log("(client scope: chat and approvals only; cannot change settings or pair others)");
  return 0;
}
