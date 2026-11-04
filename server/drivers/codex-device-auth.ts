// Codex's device-code sign-in: `codex login --device-auth`, `codex login status` to keep and confirm a login, `codex logout`.
import { stripVTControlCharacters } from "node:util";
import { deviceSignInPrompt } from "../../shared/device-sign-in.ts";
import { DeviceAuthController, type DeviceAuthOptions, type DeviceSignIn } from "./device-auth.ts";

export function codexDevicePrompt(output: string): { authorizationUrl: string; userCode: string } | null {
  return deviceSignInPrompt("codex", stripVTControlCharacters(output));
}

function loginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-auth/i.test(output)) {
    return "This server's Codex CLI needs updating for browser sign-in. Run npm install -g @openai/codex@latest on the server, then try again.";
  }
  if (/device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output)) {
    return "Enable device-code login in your ChatGPT security settings or ask your workspace admin to allow it, then try again.";
  }
  if (/expired|expiration|timed out/i.test(output)) {
    return "The ChatGPT sign-in code expired. Start sign-in again for a new code.";
  }
  return "ChatGPT sign-in did not finish. Check the server's connection and that device-code login is enabled in ChatGPT, then try again.";
}

export const CODEX_DEVICE_SIGN_IN: DeviceSignIn = {
  provider: "codex",
  product: "Codex",
  account: "ChatGPT",
  homeEnv: "CODEX_HOME",
  homeDir: ".codex",
  loginArgs: ["login", "--device-auth"],
  install: "Run npm install -g @openai/codex@latest on the server, then try again.",
  failure: loginFailure,
  status: {
    args: ["login", "status"],
    read: (code, output) =>
      code === 0 && /^logged in.*chatgpt\b/im.test(output) ? "signed-in"
      // codex-cli 0.166.0 reports an API-key login as "API key configured - sk-…".
      : code === 0 && /^(?:logged in|api key configured)\b/im.test(output) ? "other"
      : code !== 0 && /^not logged in\b/im.test(output) ? "signed-out"
      : "unknown",
  },
  logoutArgs: ["logout"],
};

export class CodexDeviceAuthController extends DeviceAuthController {
  constructor(options: DeviceAuthOptions) { super(CODEX_DEVICE_SIGN_IN, options); }
}
