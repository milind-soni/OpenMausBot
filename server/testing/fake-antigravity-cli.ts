#!/usr/bin/env node
// Offline stand-in for Google's native Antigravity CLI (1.5.x), as measured against 1.5.14, started as `antigravity acp
// --gemini-dir <dir> --app-data-dir antigravity-acp [--login]`, or `--version`. Its sign-in is the file
// <gemini-dir>/antigravity-acp/antigravity-oauth-token, which stands for the OS keyring.
//   - ACP over stdio: `initialize` names "Antigravity ACP Server" and offers `logout` and `session/close`; `authenticate`
//     always fails; `session/new` answers -32000 "Authentication required" until signed in, then offers a mode and the
//     models (one is specific to the account); `session/prompt` streams one reply; `logout` forgets the sign-in.
//   - `acp --login`: prints the sign-in link and the paste prompt on stdout, reads one line from stdin, and exits 0 after
//     writing the sign-in when the line is (or its `code` is) the accepted code, 1 otherwise. It opens no browser.
// Env knobs (all optional):
//   FAKE_AGY_LOG            file each request and login event is appended to, as JSON lines
//   FAKE_AGY_VERSION        what `--version` and initialize say (default 1.5.14)
//   FAKE_AGY_ACCEPT         the authorization code `--login` accepts (default fixture-code)
//   FAKE_AGY_ACCOUNT_MODEL  the model id only a signed-in account is offered (default fixture-account-model)
//   FAKE_AGY_LOGIN          no-link | hold | stay | bad-domain | bad-redirect | state-less: how `--login` misbehaves
//   FAKE_AGY_LOGOUT         refuse | ignore: `logout` fails, or answers and forgets nothing
//   FAKE_AGY_HANG           initialize | session-new: never answers that request; crash: exits on session/new
//   FAKE_AGY_LOGOUT_MS      how long `logout` takes before it answers
//   FAKE_AGY_KEYRING_SHARED with FAKE_AGY_KEYRING: one entry for every --gemini-dir, as the macOS keyring holds in 1.5.14
//   FAKE_AGY_SESSION_ERROR  a message session/new fails with as -32000, signed in or not
//   FAKE_AGY_KEYRING        a folder that stands for the OS keyring: the sign-in is kept there, one entry per --gemini-dir,
//                           and only `logout` removes it; ignored while SSH_CONNECTION is set, as the real CLI ignores the
//                           keyring then
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const version = process.env.FAKE_AGY_VERSION ?? "1.5.14";
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (argv.includes("--version")) {
  console.log(`antigravity ${version}`);
  process.exit(0);
}
if (argv[0] !== "acp") {
  console.error("fake antigravity: only `acp` and `--version` exist");
  process.exit(2);
}

const flag = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const geminiDir = resolve(flag("--gemini-dir") ?? ".");
const stateDir = join(geminiDir, flag("--app-data-dir") ?? "antigravity-acp");
// As 1.5.14 and 1.5.15 do: over SSH (SSH_CONNECTION set, as the app always starts it) the profile's file, never the keyring.
const credentialFile = process.env.FAKE_AGY_KEYRING && !process.env.SSH_CONNECTION
  ? join(process.env.FAKE_AGY_KEYRING, process.env.FAKE_AGY_KEYRING_SHARED ? "shared" : createHash("sha256").update(geminiDir).digest("hex"))
  : join(stateDir, "antigravity-oauth-token");
const accountModel = process.env.FAKE_AGY_ACCOUNT_MODEL ?? "fixture-account-model";
const signedIn = () => existsSync(credentialFile);

function signIn(): void {
  mkdirSync(join(credentialFile, ".."), { recursive: true });
  writeFileSync(credentialFile, `${JSON.stringify({ fixture: "offline, not a credential" })}\n`, { mode: 0o600 });
}

if (argv.includes("--login")) {
  const mode = process.env.FAKE_AGY_LOGIN ?? "";
  log({ event: "login-start" });
  if (mode === "no-link") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  const host = mode === "bad-domain" ? "https://accounts.example.test" : "https://accounts.google.com";
  const redirect = encodeURIComponent(mode === "bad-redirect" ? "http://127.0.0.1:1/" : "https://antigravity.google/oauth-callback");
  const state = mode === "state-less" ? "" : "&state=fixture-state";
  process.stdout.write([
    "Open this link in a browser to log in with Google:",
    "",
    `  ${host}/o/oauth2/auth?client_id=fixture&redirect_uri=${redirect}&response_type=code&scope=openid${state}`,
    "Then paste the authorization code, or the full URL of the page you land on, and press Enter:",
    "",
  ].join("\n"));
  if (mode === "hold") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  const line = await new Promise<string>((done) => {
    const reader = createInterface({ input: process.stdin });
    reader.once("line", (text) => { done(text.trim()); reader.close(); });
    process.stdin.once("end", () => done(""));
  });
  let code = line;
  if (/^https?:\/\//u.test(line)) code = new URL(line).searchParams.get("code") ?? "";
  const accepted = code === (process.env.FAKE_AGY_ACCEPT ?? "fixture-code");
  log({ event: "login-code", accepted, asAddress: /^https?:\/\//u.test(line) });
  if (!accepted) {
    process.stderr.write("fake antigravity: the authorization code was not accepted\n");
    process.exit(1);
  }
  signIn();
  if (mode === "stay") {
    process.stdout.write("Signed in.\n");
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  process.exit(0);
}

const out = (message: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(message as object) })}\n`);
const result = (id: unknown, value: unknown) => out({ id, result: value });
const failure = (id: unknown, code: number, message: string) => out({ id, error: { code, message } });
let mode = "default";
let model = "fixture-base-model";
let sessions = 0;

const configOptions = () => [
  { id: "mode", name: "Mode", type: "select", currentValue: mode, options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  {
    id: "model", name: "Model", type: "select", currentValue: model,
    options: [{ value: "fixture-base-model", name: "Fixture base" }, { value: accountModel, name: "Fixture account model" }],
  },
];

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message: { id?: unknown; method?: string; params?: { sessionId?: string; configId?: string; value?: string } };
  try { message = JSON.parse(line); } catch { return; }
  if (!message.method) return;
  log({ method: message.method, signedIn: signedIn() });
  switch (message.method) {
    case "initialize":
      if (process.env.FAKE_AGY_HANG === "initialize") return;
      result(message.id, {
        protocolVersion: 1,
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: { name: "Antigravity ACP Server", version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { resume: {}, close: {} },
          auth: { logout: {} },
        },
      });
      break;
    case "authenticate":
      failure(message.id, -32603, "fake antigravity does not sign in through authenticate; use acp --login");
      break;
    case "logout":
      log({ event: "logout-start" });
      if (process.env.FAKE_AGY_LOGOUT_MS) await new Promise((resolveWait) => setTimeout(resolveWait, Number(process.env.FAKE_AGY_LOGOUT_MS)));
      if (process.env.FAKE_AGY_LOGOUT === "refuse") failure(message.id, -32603, "logout refused");
      else {
        if (process.env.FAKE_AGY_LOGOUT !== "ignore") rmSync(credentialFile, { force: true });
        result(message.id, {});
      }
      break;
    case "session/new":
      if (process.env.FAKE_AGY_HANG === "session-new") return;
      if (process.env.FAKE_AGY_HANG === "crash") process.exit(3);
      if (process.env.FAKE_AGY_SESSION_ERROR) return failure(message.id, -32000, process.env.FAKE_AGY_SESSION_ERROR);
      if (!signedIn()) return failure(message.id, -32000, "Authentication required");
      sessions += 1;
      result(message.id, { sessionId: `fixture-session-${process.pid}-${sessions}`, configOptions: configOptions() });
      break;
    case "session/set_config_option":
      if (message.params?.configId === "mode") mode = String(message.params.value);
      if (message.params?.configId === "model") model = String(message.params.value);
      result(message.id, { configOptions: configOptions() });
      break;
    case "session/prompt":
      out({ method: "session/update", params: { sessionId: message.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture reply" } } } });
      result(message.id, { stopReason: "end_turn" });
      break;
    default:
      result(message.id, {});
  }
}).on("close", () => process.exit(0));
