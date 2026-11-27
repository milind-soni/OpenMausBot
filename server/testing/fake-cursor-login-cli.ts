#!/usr/bin/env node
// Offline stand-in for Cursor's `cursor-agent` sign-in commands, printing what cursor-agent 2026.10.22 prints: no
// network, no real credential; needs explicit opt-in and a disposable HOME.
//   FAKE_CURSOR_MODE  approve (signed in once HOME/.omb-fake-cursor-approved exists, as when the person finishes in their
//     browser) | evil (a link on another host) | extra (a link carrying a token) | crash | curl (answers --version as
//     curl does, as an install command pasted as the CLI path runs)
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const home = process.env.HOME;
if (process.env.OMB_DEVICE_AUTH_FIXTURE !== "1" || !home || !isAbsolute(home)) {
  process.stderr.write("This fake CLI requires OMB_DEVICE_AUTH_FIXTURE=1 and an isolated HOME.\n");
  process.exit(2);
}
const mode = process.env.FAKE_CURSOR_MODE || "approve";
const args = process.argv.slice(2);
const auth = join(home, ".config", "cursor", "auth.json");
appendFileSync(join(home, "fake-cursor-calls.jsonl"), `${JSON.stringify({ args, noOpenBrowser: process.env.NO_OPEN_BROWSER ?? null })}\n`);

const CHALLENGE = "Jx1fQ3-Vq8kP0Yb_5rT2aWm7nC4dE6gH9iL0oS1uZ2y";
const UUID = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
const link = mode === "evil" ? `https://cursor.com.evil.test/loginDeepControl?challenge=${CHALLENGE}&uuid=${UUID}`
  : mode === "extra" ? `https://cursor.com/loginDeepControl?challenge=${CHALLENGE}&uuid=${UUID}&mode=login&token=secret-token`
  : `https://cursor.com/loginDeepControl?challenge=${CHALLENGE}&uuid=${UUID}&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true`;

if (args.join(" ") === "--version") {
  process.stdout.write(mode === "curl" ? "curl 7.88.1 (x86_64-pc-linux-gnu) libcurl/7.88.1 OpenSSL/3.0.22\nRelease-Date: 2023-02-20\n" : "2026.10.22-27dcf5f\n");
} else if (args.join(" ") === "status --format json") {
  const signedIn = existsSync(auth);
  process.stdout.write(`${JSON.stringify({ status: signedIn ? "authenticated" : "unauthenticated", isAuthenticated: signedIn, hasAccessToken: signedIn, hasRefreshToken: signedIn }, null, 2)}\n`);
} else if (args.join(" ") === "status") {
  process.stdout.write(existsSync(auth) ? "Logged in\n" : "Not logged in\n");
} else if (args.join(" ") === "login") {
  writeFileSync(join(home, "fake-cursor-login.pid"), String(process.pid));
  process.stdout.write(["Starting login process...", "Authenticating with Cursor...", "Waiting for browser authentication...", `Open a browser and navigate to this link: ${link}`, ""].join("\n"));
  if (mode === "crash") setTimeout(() => { process.stderr.write("access_token=secret-token\n"); process.exit(1); }, 80);
  else setInterval(() => {
    if (!existsSync(join(home, ".omb-fake-cursor-approved"))) return;
    mkdirSync(join(home, ".config", "cursor"), { recursive: true });
    writeFileSync(auth, "{\"fixture\":\"offline, not a credential\"}\n", { mode: 0o600 });
    process.stdout.write("Login successful!\n");
    process.exit(0);
  }, 50);
} else {
  process.stderr.write("Unsupported offline fixture command.\n");
  process.exitCode = 2;
}
