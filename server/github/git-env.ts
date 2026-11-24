// A bot's git settings for GitHub, carried in its environment only: never a file, never the person's ~/.gitconfig.
// They go in GIT_CONFIG_PARAMETERS, the variable `git -c` itself hands to the gits it starts. GIT_CONFIG_COUNT with
// GIT_CONFIG_KEY_<n> would not survive: Codex's shell drops every variable whose name holds KEY, and a count whose keys
// are gone makes every git command fail. Each entry is written `'name=value'`, which every git since 2.0 reads.

/** git's own shell quoting of one word (quote.c sq_quote). */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/** `entries` added after whatever `existing` (a GIT_CONFIG_PARAMETERS value) already holds. */
export function gitConfigParameters(entries: ReadonlyArray<readonly [string, string]>, existing?: string): string {
  const ours = entries.map(([name, value]) => {
    if (name.includes("=") || /[\0\n]/.test(name) || /[\0\n]/.test(value)) throw new Error(`Not a git setting: ${name.slice(0, 60)}`);
    return shellQuote(`${name}=${value}`);
  }).join(" ");
  return existing?.trim() ? `${existing.trim()} ${ours}` : ours;
}

/** The forms of a github.com remote the box sends through the broker: HTTPS, and the SSH ones, which then go over HTTPS. */
export const GITHUB_REMOTE_FORMS = ["https://github.com/", "git@github.com:", "ssh://git@github.com/"] as const;

/** A boxed bot's git: every GitHub remote through `brokerBase` (http://127.0.0.1:<port>/b/<token>/github), no
 * credential helper of any layer (the broker adds the credential), and no prompt. */
export function boxGitEnv(brokerBase: string): Record<string, string> {
  const url = `url.${brokerBase.replace(/\/+$/, "")}/.insteadof`;
  return {
    GIT_CONFIG_PARAMETERS: gitConfigParameters([...GITHUB_REMOTE_FORMS.map((form) => [url, form] as const), ["credential.helper", ""]]),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The header the credential helper sends its secret in (server/github/git-credential.ts). */
export const GIT_CREDENTIAL_HEADER = "x-omb-git-credential";
export const GIT_CREDENTIAL_PATH = "/api/github/git-credential";

/** The credential helper of an unboxed bot (This computer): for github.com only, asked after the person's own helpers,
 * so their own working credentials still win; it asks this server for the token with the spawn's secret. curl comes with
 * macOS, Windows 10 and later, and Git for Windows' shell, so the helper names no path of this machine. */
export function unboxedGitEnv(input: { port: number; secret: string; existing?: string }): Record<string, string> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.secret) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new Error("Not a git credential helper.");
  const helper = `!f() { test "$1" = get || exit 0; curl -fsS --noproxy 127.0.0.1 --max-time 30 -H "${GIT_CREDENTIAL_HEADER}: ${input.secret}" "http://127.0.0.1:${input.port}${GIT_CREDENTIAL_PATH}"; }; f`;
  return { GIT_CONFIG_PARAMETERS: gitConfigParameters([["credential.https://github.com.helper", helper]], input.existing) };
}
