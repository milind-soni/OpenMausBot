// Where a person enters the one-time code that signs an engine's CLI in on
// the machine running OpenMausBot (`codex login --device-auth`, `grok login
// --device-auth`, `kimi login`), or, for a CLI that prints no code (`cursor-agent
// login`), the one link that finishes its sign-in. The server reads the page and
// the code from the CLI's output with these rules, and the app checks them again
// before it shows a link. Neither ever turns arbitrary output into a link, or lets
// a token ride along in one.

export type DeviceSignInProvider = "codex" | "grok" | "kimi" | "cursor";

const CODEX_PAGE = "https://auth.openai.com/codex/device";

/** An https page on one of the provider's hosts, with no login, port or fragment. */
function providerPage(value: string, hosts: RegExp): URL | null {
  if (!/^https:\/\/[^\s#]+$/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url.username || url.password || url.port || !hosts.test(url.hostname) ? null : url;
}

const RULES: Record<DeviceSignInProvider, {
  page(value: string): string | null;
  /** null: the link alone finishes the sign-in, and no code is shown. */
  code: RegExp | null;
  /** The words a CLI prints before the page or the code on the same line. */
  label?: RegExp;
}> = {
  codex: {
    page: (value) => (/^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(value) ? CODEX_PAGE : null),
    code: /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/,
  },
  grok: {
    // xAI's own sign-in hosts. The page may carry the code itself (the
    // provider's "complete" link); nothing else may ride in its query.
    page: (value) => {
      const url = providerPage(value, /(^|\.)(x\.ai|grok\.com)$/);
      return url && [...url.searchParams.keys()].every((key) => key === "user_code") ? url.href : null;
    },
    code: /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,3}$/,
  },
  kimi: {
    // Moonshot's hosts for both Kimi Code regions (kimi.com, kimi.ai). Its
    // OAuth server writes the "complete" link, so only the code is kept of
    // its query. kimi-code 2.4.1 prints "…device login: <page>" and "…enter
    // code: <code>".
    page: (value) => {
      const url = providerPage(value, /(^|\.)kimi\.(com|ai)$/);
      if (!url) return null;
      const code = url.searchParams.get("user_code");
      url.search = "";
      if (code !== null) url.searchParams.set("user_code", code);
      return url.href;
    },
    code: /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,3}$/,
    label: /^[^:]*\b(?:login|code):\s+/i,
  },
  cursor: {
    // cursor-agent 2026.10.22 prints "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?…"
    // and waits for that sign-in. Its query names the sign-in request (a PKCE challenge and a request id) the CLI then
    // collects, never a token; only those and Cursor's own flags may ride in it.
    page: (value) => {
      const url = providerPage(value, /^(www\.)?cursor\.com$/);
      if (!url || url.pathname !== "/loginDeepControl") return null;
      const keys = [...url.searchParams.keys()];
      const known = keys.every((key) => ["challenge", "uuid", "mode", "redirectTarget", "supportsSelectedTeamLogin"].includes(key));
      const request = /^[\w-]{16,128}$/.test(url.searchParams.get("challenge") ?? "") && /^[\w-]{8,64}$/.test(url.searchParams.get("uuid") ?? "");
      return known && request && new Set(keys).size === keys.length ? url.href : null;
    },
    code: null,
    label: /^[^:]*\blink:\s+/i,
  },
};

/** Whether this provider's CLI prints a code to enter, or only a link that finishes the sign-in. */
export function deviceSignInHasCode(provider: DeviceSignInProvider): boolean {
  return RULES[provider].code !== null;
}

/** The provider's own page for entering `userCode`, or null for anything
 * else. A code carried in the page's link must be that same code. */
export function deviceSignInLink(provider: DeviceSignInProvider, value: string | null | undefined, userCode?: string): string | null {
  const page = value ? RULES[provider].page(value) : null;
  if (!page) return null;
  if (!deviceSignInHasCode(provider)) return userCode === undefined ? page : null;
  return [...new URL(page).searchParams.values()].every((carried) => carried === userCode) ? page : null;
}

/** A one-time code as this provider formats it. */
export function isDeviceSignInCode(provider: DeviceSignInProvider, value: string | null | undefined): value is string {
  const code = RULES[provider].code;
  return typeof value === "string" && code !== null && code.test(value);
}

/** The newest page and code from a CLI's output, once both lines have
 * arrived whole: output arrives in chunks that may stop halfway through a
 * code, so the last, unfinished line is never read. A CLI can print a new
 * pair when its code expires (kimi-code 2.4.1 does). `text` is already free
 * of terminal styling. */
export function deviceSignInPrompt(provider: DeviceSignInProvider, text: string): { authorizationUrl: string; userCode?: string } | null {
  const { page, label } = RULES[provider];
  const lines = text.split(/\r?\n/).slice(0, -1).map((line) => (label ? line.trim().replace(label, "") : line.trim()));
  let prompt: { authorizationUrl: string; userCode?: string } | null = null;
  for (const [at, line] of lines.entries()) {
    if (page(line) === null) continue;
    if (!deviceSignInHasCode(provider)) {
      prompt = { authorizationUrl: page(line)! };
      continue;
    }
    const userCode = lines.slice(at + 1).map((next) => next.replace(/^code:\s*/i, "")).find((next) => isDeviceSignInCode(provider, next));
    const authorizationUrl = userCode ? deviceSignInLink(provider, line, userCode) : null;
    if (authorizationUrl && userCode) prompt = { authorizationUrl, userCode };
  }
  return prompt;
}
