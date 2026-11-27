#!/usr/bin/env node
// Offline stand-in for Moonshot's `kimi` CLI sign-in (`--version`, `login` printing kimi-code 2.4.1's device
// instructions to stderr): no network, no real credential; needs explicit opt-in and a disposable HOME.
//   FAKE_KIMI_MODE  success | global (kimi.ai, saved under its own token name) | approve (once
//     HOME/.omb-fake-kimi-approved exists) | waiting | renew (a new code, as once the first expires) | extra (a page with
//     another query value) | evil (a page on another host) | expired | denied | crash | no-credential | ignore-term
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const home = process.env.HOME;
if (process.env.OMB_DEVICE_AUTH_FIXTURE !== "1" || !home || !isAbsolute(home)) {
  process.stderr.write("This fake CLI requires OMB_DEVICE_AUTH_FIXTURE=1 and an isolated HOME.\n");
  process.exit(2);
}
const kimiHome = process.env.KIMI_CODE_HOME || join(home, ".kimi-code");
const mode = process.env.FAKE_KIMI_MODE || "success";
const args = process.argv.slice(2);
appendFileSync(join(home, "fake-kimi-calls.jsonl"), `${JSON.stringify({ args, home, kimiHome, moonshotKey: process.env.MOONSHOT_API_KEY ?? null })}\n`);

const signIn = () => {
  mkdirSync(join(kimiHome, "credentials"), { recursive: true });
  const token = mode === "global" ? "kimi-code-env-0e4f99c69cc27850.json" : "kimi-code.json";
  writeFileSync(join(kimiHome, "credentials", token), "{\"fixture\":\"offline, not a credential\"}\n", { mode: 0o600 });
  process.stderr.write("Logged in to Kimi Code.\n");
  process.exit(0);
};

if (args.join(" ") === "--version") {
  process.stdout.write("2.4.1\n");
} else if (args.join(" ") === "login") {
  writeFileSync(join(home, "fake-kimi-login.pid"), String(process.pid));
  const prompt = (code: string) => {
    const page = mode === "evil" ? `https://kimi.com.evil.test/device?user_code=${code}`
      : mode === "extra" ? `https://www.kimi.com/code/authorize_device?user_code=${code}&state=secret-token`
      : mode === "global" ? `https://www.kimi.ai/code/authorize_device?user_code=${code}`
      : `https://www.kimi.com/code/authorize_device?user_code=${code}`;
    process.stderr.write([
      "",
      `Opening browser for Kimi device login: ${page}`,
      `If the browser did not open, paste the URL above and enter code: ${code}`,
      "Code expires in 600s.",
      "Waiting for authorization to complete…",
      "",
    ].join("\n"));
  };
  prompt("QKXP-7M4D");
  const later = (then: () => void) => setTimeout(then, 80);
  if (mode === "success" || mode === "extra" || mode === "global") later(signIn);
  else if (mode === "approve") setInterval(() => { if (existsSync(join(home, ".omb-fake-kimi-approved"))) signIn(); }, 100);
  else if (mode === "no-credential") later(() => process.exit(0));
  else if (mode === "renew") { later(() => prompt("RW7N-2KQ9")); setInterval(() => {}, 1000); }
  else if (mode === "expired") later(() => { process.stderr.write("Login failed: Device authorization timed out after 900s secret-token\n"); process.exit(1); });
  else if (mode === "denied") later(() => { process.stderr.write("Login cancelled: access_denied secret-token\n"); process.exit(1); });
  else if (mode === "crash") later(() => { process.stderr.write("access_token=secret-token\n"); process.exit(1); });
  else {
    if (mode === "ignore-term") process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  }
} else {
  process.stderr.write("Unsupported offline fixture command.\n");
  process.exitCode = 2;
}
