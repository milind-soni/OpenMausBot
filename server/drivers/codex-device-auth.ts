// Codex's device-code sign-in: `codex login --device-auth`, `codex login status` to keep and confirm a login, `codex logout`.
import { stripVTControlCharacters } from "node:util";
import type { SignInOutcome } from "../../shared/sign-in-outcome.ts";
import { deviceSignInPrompt } from "../../shared/device-sign-in.ts";
import { DeviceAuthController, type DeviceAuthOptions, type DeviceSignIn } from "./device-auth.ts";
import { codexReportsLogin } from "./codex-login.ts";

export function codexDevicePrompt(output: string): { authorizationUrl: string; userCode: string } | null {
  const prompt = deviceSignInPrompt("codex", stripVTControlCharacters(output));
  return prompt?.userCode ? { authorizationUrl: prompt.authorizationUrl, userCode: prompt.userCode } : null;
}

function loginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-auth/i.test(output)) {
    return "This server's Codex CLI needs updating for browser sign-in. Run npm install -g @openai/codex@latest on the server, then try again.";
  }
  if (/device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output)) {
    return "OpenAI did not allow device code sign-in. Turn it on in ChatGPT Settings → Security (your ChatGPT admin may need to), then try again.";
  }
  if (/expired|expiration|timed out/i.test(output)) {
    return "The ChatGPT sign-in code expired. Start sign-in again for a new code.";
  }
  return "ChatGPT sign-in did not finish. If OpenAI said device code sign-in isn't allowed, turn it on in ChatGPT Settings → Security (your ChatGPT admin may need to), then try again.";
}

/** `loginFailure` as a fixed code: an expired code, device sign-in refused by the account's settings, else the command ended. */
function loginFailureReason(output: string): SignInOutcome {
  if (/device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output)) return "refused";
  if (/expired|expiration|timed out/i.test(output)) return "expired";
  return "exited";
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
  failureReason: loginFailureReason,
  status: {
    args: ["login", "status"],
    read: (code, output) =>
      code === 0 && /^logged in.*chatgpt\b/im.test(output) ? "signed-in"
      : code === 0 && codexReportsLogin(output) ? "other"
      : code !== 0 && /^not logged in\b/im.test(output) ? "signed-out"
      : "unknown",
  },
  logoutArgs: ["logout"],
};

export class CodexDeviceAuthController extends DeviceAuthController {
  constructor(options: DeviceAuthOptions) { super(CODEX_DEVICE_SIGN_IN, options); }
}
