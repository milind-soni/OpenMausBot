// report_finding's arguments, as the agents bridge checks them before the call and the server checks them again: what a
// bot found, where, its https links, and the key that keeps the same news from reaching the person twice.
export const FOUND_LIMITS = { title: 120, details: 600, source: 60, key: 300, links: 3, linkLabel: 40, url: 2048 } as const;

export interface FindingInput { title: string; details: string; source?: string; links: Array<{ label: string; url: string }>; key: string }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const line = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** Security invariant: only an https link with no username or password is kept. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > FOUND_LIMITS.url) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The tool's arguments as one update, or what is wrong with them in one sentence. */
export function parseFindingInput(value: unknown): { ok: true; value: FindingInput } | { ok: false; error: string } {
  if (!record(value)) return { ok: false, error: "report_finding takes title, details and key." };
  const title = line(value.title), details = typeof value.details === "string" ? value.details.trim() : "", key = line(value.key), source = line(value.source);
  if (!title || title.length > FOUND_LIMITS.title) return { ok: false, error: `title: one line of at most ${FOUND_LIMITS.title} characters saying what you found.` };
  if (!details || details.length > FOUND_LIMITS.details) return { ok: false, error: `details: at most ${FOUND_LIMITS.details} characters on what it means for the person and what you did about it.` };
  if (!key || key.length > FOUND_LIMITS.key) return { ok: false, error: "key: what this is about, stable across runs: a URL, an email or issue id." };
  if (source.length > FOUND_LIMITS.source) return { ok: false, error: `source: at most ${FOUND_LIMITS.source} characters naming where you found it.` };
  const given = value.links === undefined || value.links === null ? [] : value.links;
  if (!Array.isArray(given) || given.length > FOUND_LIMITS.links) return { ok: false, error: `links: at most ${FOUND_LIMITS.links}, each {label, url}.` };
  const links: FindingInput["links"] = [];
  for (const one of given) {
    const label = record(one) ? line(one.label) : "", url = record(one) ? httpsUrl(one.url) : undefined;
    if (!label || label.length > FOUND_LIMITS.linkLabel || !url) return { ok: false, error: `links: each needs a label of at most ${FOUND_LIMITS.linkLabel} characters and an https url.` };
    links.push({ label, url });
  }
  return { ok: true, value: { title, details, key, links, ...(source ? { source } : {}) } };
}
