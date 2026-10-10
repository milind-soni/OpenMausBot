// Where a person enters the one-time code that signs an engine's CLI in on
// the machine running OpenMausBot (`codex login --device-auth`, `grok login
// --device-auth`). The server reads the page and the code from the CLI's
// output with these rules, and the app checks them again before it shows a
// link. Neither ever turns arbitrary output into a link, or lets a token ride
// along in one.

export type DeviceSignInProvider = "codex" | "grok";

const CODEX_PAGE = "https://auth.openai.com/codex/device";

const RULES: Record<DeviceSignInProvider, { page(value: string): string | null; code: RegExp }> = {
  codex: {
    page: (value) => (/^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(value) ? CODEX_PAGE : null),
    code: /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/,
  },
  grok: {
    // xAI's own sign-in hosts. The page may carry the code itself (the
    // provider's "complete" link); nothing else may ride in its query.
    page: (value) => {
      if (!/^https:\/\/[^\s#]+$/.test(value)) return null;
      let url: URL;
      try { url = new URL(value); } catch { return null; }
      if (url.username || url.password || url.port || !/(^|\.)(x\.ai|grok\.com)$/.test(url.hostname)) return null;
      return [...url.searchParams.keys()].every((key) => key === "user_code") ? url.href : null;
    },
    code: /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,3}$/,
  },
};

/** The provider's own page for entering `userCode`, or null for anything
 * else. A code carried in the page's link must be that same code. */
export function deviceSignInLink(provider: DeviceSignInProvider, value: string | null | undefined, userCode?: string): string | null {
  const page = value ? RULES[provider].page(value) : null;
  if (!page) return null;
  return [...new URL(page).searchParams.values()].every((carried) => carried === userCode) ? page : null;
}

/** A one-time code as this provider formats it. */
export function isDeviceSignInCode(provider: DeviceSignInProvider, value: string | null | undefined): value is string {
  return typeof value === "string" && RULES[provider].code.test(value);
}

/** The page and the code from a CLI's output, once both lines have arrived
 * whole: output arrives in chunks that may stop halfway through a code, so
 * the last, unfinished line is never read. `text` is already free of
 * terminal styling. */
export function deviceSignInPrompt(provider: DeviceSignInProvider, text: string): { authorizationUrl: string; userCode: string } | null {
  const lines = text.split(/\r?\n/).slice(0, -1).map((line) => line.trim());
  const at = lines.findIndex((line) => RULES[provider].page(line) !== null);
  if (at < 0) return null;
  const userCode = lines.slice(at + 1).map((line) => line.replace(/^code:\s*/i, "")).find((line) => isDeviceSignInCode(provider, line));
  const authorizationUrl = userCode ? deviceSignInLink(provider, lines[at], userCode) : null;
  return authorizationUrl && userCode ? { authorizationUrl, userCode } : null;
}
