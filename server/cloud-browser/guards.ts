// What a browser in the Cloud's browser sandbox is kept from, at the home before a call reaches it: every bot's Chrome
// there runs as the same user, so a local page could read another bot's profile. Its downloads stay in the sandbox.

/** Schemes that open what is on the sandbox's own disk or Chrome's own pages, never a website. */
const LOCAL_SCHEME = /^\s*(file|chrome|chrome-untrusted|devtools|view-source|filesystem|chrome-extension):/i;

export const LOCAL_SCHEME_REFUSAL = "This browser opens websites only: files and the browser's own pages (file:, chrome:, view-source: and the like) are not opened here.";

/** Any string in a call's arguments that names a local scheme, however deep. */
function namesLocal(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return LOCAL_SCHEME.test(value);
  if (depth > 4 || !value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => namesLocal(item, depth + 1));
}

/** The refusal for a tool call that would open a local scheme in the sandbox, or null. */
export function localSchemeRefusal(params: unknown): string | null {
  return namesLocal((params as { arguments?: unknown } | null)?.arguments) ? LOCAL_SCHEME_REFUSAL : null;
}

export const DOWNLOAD_NOTE = "This browser runs in the Cloud's browser sandbox, which doesn't save downloads yet: if that action started a download, the file was not kept. Tell the person in one sentence and ask them to download it themselves.";

/** What the engine says when a navigation turned into a download (Chrome cancels the page load), not a page's own words. */
const DOWNLOAD_SIGNS = /net::ERR_ABORTED|\bdownload (?:started|began|will begin|was blocked)\b/i;

/** A call whose answer says a download started or a navigation was cut off by one gets the note, once, at its end. */
export function downloadNote(result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result;
  const text = content.map((part) => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
  if (!DOWNLOAD_SIGNS.test(text) || text.includes(DOWNLOAD_NOTE)) return result;
  return { ...(result as object), content: [...content, { type: "text", text: DOWNLOAD_NOTE }] };
}
