#!/usr/bin/env node
// One-command telephony dev: start a cloudflared quick tunnel on the webhook
// port, write its URL into Twilio's voice/SMS webhooks, then start the dev
// server with that URL as TELEPHONY_PUBLIC_URL. The quick-tunnel hostname is
// random per launch, so repointing Twilio here is what keeps calls working
// across restarts without a paid tunnel or a domain.
//
// Usage:
//   node scripts/telephony-dev.mjs --env-file <path-to-.env>
//
// Reads the same keys the server does: OMB_PORT / OMB_WEBHOOK_PORT,
// TWILIO_ACCOUNT_SID with either TWILIO_AUTH_TOKEN or the
// TWILIO_API_KEY_SID:TWILIO_API_KEY_SECRET pair, TWILIO_PHONE_NUMBER.
// Secrets are never printed; only the public tunnel URL is.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_URL_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file" && argv[i + 1]) {
      out.envFile = argv[i + 1];
      i++;
    }
  }
  return out;
}

export function loadEnvFile(file) {
  const out = {};
  if (!file) return out;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function webhookPort(env) {
  const port = Number(env.OMB_PORT || 8799);
  return Number(env.OMB_WEBHOOK_PORT || port + 1);
}

export function cloudflaredPath(repoRoot, platform = process.platform) {
  const dir = platform === "win32" ? "win32-x64" : platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const exe = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const local = path.join(repoRoot, "dist-native", "cloudflared", dir, exe);
  return fs.existsSync(local) ? local : "cloudflared";
}

export function twilioAuth(env) {
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return { sid: env.TWILIO_API_KEY_SID, token: env.TWILIO_API_KEY_SECRET };
  }
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    return { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
  }
  return null;
}

async function twilioFetch(env, auth, url, init) {
  const basic = Buffer.from(`${auth.sid}:${auth.token}`).toString("base64");
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Twilio ${url} -> ${res.status} ${body.code || ""} ${body.message || ""}`.trim());
  }
  return body;
}

export async function repointTwilio(env, publicUrl) {
  const auth = twilioAuth(env);
  if (!auth) throw new Error("no Twilio credentials in env");
  const { sid: accountSid } = auth;
  const phone = env.TWILIO_PHONE_NUMBER;
  if (!phone) throw new Error("TWILIO_PHONE_NUMBER not set");
  const base = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  const listed = await twilioFetch(env, auth, `${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`, {});
  const number = (listed.incoming_phone_numbers || []).find((n) => n.phone_number === phone);
  if (!number) throw new Error(`${phone} is not an incoming number on this Twilio account`);
  const form = new URLSearchParams({
    VoiceUrl: `${publicUrl}/hooks/telephony/voice`,
    VoiceMethod: "POST",
    SmsUrl: `${publicUrl}/hooks/telephony/sms`,
    SmsMethod: "POST",
  });
  const updated = await twilioFetch(env, auth, `${base}/IncomingPhoneNumbers/${number.sid}.json`, { method: "POST", body: form.toString() });
  return { sid: updated.sid, phone: updated.phone_number };
}

function startTunnel(exe, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["tunnel", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("no trycloudflare.com URL appeared in cloudflared output"));
    }, TUNNEL_URL_TIMEOUT_MS);
    const onLine = (chunk) => {
      const m = TUNNEL_URL_RE.exec(String(chunk));
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[0].replace(/[| ]/g, "") });
      }
    };
    child.stdout.on("data", onLine);
    child.stderr.on("data", onLine);
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("cloudflared exited before a tunnel URL appeared"));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const fileEnv = fs.existsSync(args.envFile || "") ? loadEnvFile(args.envFile) : {};
  const env = { ...fileEnv, ...process.env };
  const port = webhookPort(env);
  const exe = cloudflaredPath(repoRoot);
  console.log(`[telephony-dev] starting cloudflared on 127.0.0.1:${port} (${exe === "cloudflared" ? "from PATH" : exe})`);
  const { child: tunnel, url } = await startTunnel(exe, port);
  console.log(`[telephony-dev] tunnel up: ${url}`);
  try {
    const done = await repointTwilio(env, url);
    console.log(`[telephony-dev] Twilio repointed: ${done.phone} -> ${url}/hooks/telephony/{voice,sms}`);
  } catch (err) {
    tunnel.kill();
    throw err;
  }
  const server = spawn(process.execPath, ["--experimental-strip-types", "server/dev-server.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...env, TELEPHONY_PUBLIC_URL: url },
  });
  const stopAll = () => {
    tunnel.kill();
    server.kill();
  };
  process.on("SIGINT", stopAll);
  tunnel.on("exit", () => server.kill());
  server.on("exit", (code) => {
    tunnel.kill();
    process.exit(code ?? 0);
  });
}

if (import.meta.dirname === path.dirname(process.argv[1] || "")) {
  main().catch((err) => {
    console.error(`[telephony-dev] fatal: ${err.message}`);
    process.exit(1);
  });
}
