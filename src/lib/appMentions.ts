// `+app` tags: the composer picker and chips in sent messages. The harness
// re-parses tags itself (server/apps/prompt.ts), so these only drive the UI.

export interface AppMentionQuery {
  start: number;
  query: string;
}

export interface AppMentionMatch {
  start: number;
  end: number;
  text: string;
  appId: string;
}

/** A `+` at a word start followed by letters (never digits: `+44` is a phone number). */
export function appMentionQueryAt(text: string, caret: number): AppMentionQuery | null {
  const upto = text.slice(0, caret);
  const start = upto.lastIndexOf("+");
  if (start < 0) return null;
  if (start > 0 && !/[\s([{"']/.test(upto[start - 1])) return null;
  const query = upto.slice(start + 1);
  if (query.length > 32 || !/^([a-z][a-z0-9-]*)?$/i.test(query)) return null;
  return { start, query };
}

export function insertAppMention(text: string, caret: number, query: AppMentionQuery, appId: string) {
  const next = `${text.slice(0, query.start)}+${appId} ${text.slice(caret).replace(/^ /, "")}`;
  return { text: next, caret: query.start + appId.length + 2 };
}

export function appMentionMatches(text: string, appIds: string[]): AppMentionMatch[] {
  if (!text || !appIds.length) return [];
  const known = new Set(appIds.map((id) => id.toLowerCase()));
  const matches: AppMentionMatch[] = [];
  for (const match of text.matchAll(/\+[a-z][a-z0-9-]*/gi)) {
    const start = match.index;
    if (start > 0 && !/[\s([{"']/.test(text[start - 1])) continue;
    const token = match[0].replace(/-+$/, "");
    const appId = token.slice(1).toLowerCase();
    if (!known.has(appId)) continue;
    matches.push({ start, end: start + token.length, text: token, appId });
  }
  return matches;
}
