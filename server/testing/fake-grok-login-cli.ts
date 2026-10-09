#!/usr/bin/env node
// Offline stand-in for xAI's `grok` CLI in its sign-in role: `--version` and
// `login --device-auth`, printing the device instructions the way grok 1.0.25
// does. It never opens a network connection and writes no real credential.
// Explicit opt-in and a disposable HOME are required.
//
// FAKE_GROK_MODE: success (signs in shortly), approve (signs in once
// HOME/.omb-fake-grok-approved exists), waiting, complete (the page carries
// the code), evil (a page on another host), expired, denied, crash,
// no-credential (exits 0 without signing in), old (no --device-auth),
// ignore-term (waits and ignores SIGTERM).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const home = process.env.HOME;
if (process.env.OMB_DEVICE_AUTH_FIXTURE !== "1" || !home || !isAbsolute(home)) {
  process.stderr.write("This fake CLI requires OMB_DEVICE_AUTH_FIXTURE=1 and an isolated HOME.\n");
  process.exit(2);
}
const grokHome = process.env.GROK_HOME || join(home, ".grok");
const mode = process.env.FAKE_GROK_MODE || "success";
const args = process.argv.slice(2);
appendFileSync(join(home, "fake-grok-calls.jsonl"), `${JSON.stringify({ args, home, grokHome, xaiKey: process.env.XAI_API_KEY ?? null })}\n`);

const signIn = () => {
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "auth.json"), "{\"fixture\":\"offline, not a credential\"}\n", { mode: 0o600 });
  process.stderr.write("Signed in to Grok.\n");
  process.exit(0);
};

if (args.join(" ") === "--version") {
  process.stdout.write("grok 1.0.41 (fixture)\n");
} else if (args.join(" ") === "login --device-auth") {
  writeFileSync(join(home, "fake-grok-login.pid"), String(process.pid));
  if (mode === "old") {
    process.stderr.write("error: unexpected argument '--device-auth' found secret-token\n");
    process.exit(2);
  }
  const code = "WDJB-MJHT";
  const page = mode === "evil" ? "https://x.ai.evil.test/device"
    : mode === "complete" ? `https://accounts.x.ai/device?user_code=${code}` : "https://accounts.x.ai/device";
  process.stderr.write(`\nTo sign in, open this URL in your browser:\n    \u001b[1m${page}\u001b[0m\n`);
  process.stderr.write("    (Could not open browser automatically — open the URL above manually.)\n");
  process.stderr.write(`\n${mode === "complete" ? "Confirm this code in your browser:" : "Then enter this code:"}\n    \u001b[1m${code}\u001b[0m\n`);
  process.stderr.write("\u001b[90mOnly continue with a code you requested. Don't share it with anyone.\u001b[0m\nWaiting for authorization...\n");
  const later = (then: () => void) => setTimeout(then, 80);
  if (mode === "success" || mode === "complete") later(signIn);
  else if (mode === "approve") setInterval(() => { if (existsSync(join(home, ".omb-fake-grok-approved"))) signIn(); }, 100);
  else if (mode === "no-credential") later(() => process.exit(0));
  else if (mode === "expired") later(() => { process.stderr.write("Device code expired. Run `grok login --device-auth` again. secret-token\n"); process.exit(1); });
  else if (mode === "denied") later(() => { process.stderr.write("Authorization denied. The user rejected the request. secret-token\n"); process.exit(1); });
  else if (mode === "crash") later(() => { process.stderr.write("access_token=secret-token\n"); process.exit(1); });
  else {
    if (mode === "ignore-term") process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  }
} else {
  process.stderr.write("Unsupported offline fixture command.\n");
  process.exitCode = 2;
}
