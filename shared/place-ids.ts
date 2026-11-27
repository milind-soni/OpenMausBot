// A My Cloud bot opened in place on this computer's page (server/places/place-proxy.ts, src/lib/place-chat.ts): its
// conversation is read and written through this computer's own server, which forwards it to My Cloud. Every id of My
// Cloud's that crosses into this page carries My Cloud's key in front (`cloud:<id>`), the same key the one list's rows
// already use (src/lib/place-rows.ts), so a bot, a conversation or a file of My Cloud's never meets one of this computer's
// with the same id. This computer's own ids are `[\w-]` only, so nothing of its own ever starts with the key.
//
// Pure: the server rewrites with it at the boundary, and the page tells a placed id by it.

/** The one place a bot opens in place from today: the person's own My Cloud. */
export const PLACE_KEY = "cloud";
const PREFIX = `${PLACE_KEY}:`;
/** A file of My Cloud's, by the name this page asks for it (`/api/attachments/<name>`): the page only asks for names
 * of letters, digits and dashes, so the key goes in front with dashes. */
export const PLACE_FILE_PREFIX = `${PLACE_KEY}--`;

export const isPlaceId = (value: unknown): value is string => typeof value === "string" && value.startsWith(PREFIX) && value.length > PREFIX.length;
/** My Cloud's own id as this page names it. */
export const placeId = (id: string): string => (isPlaceId(id) ? id : `${PREFIX}${id}`);
/** The id My Cloud itself knows, from the one this page names. */
export const ownId = (id: string): string => (isPlaceId(id) ? id.slice(PREFIX.length) : id);

/** The keys, in the frames and bodies a conversation uses, whose values are a bot's or a conversation's id (or a list
 * of them). Only these are rewritten, and never inside what anyone wrote or a card's own data (WRITTEN): a message that
 * starts with "cloud:" stays as written, and a key a bot or a routine chose is never taken for an id. */
const ID_KEYS = new Set(["botId", "threadId", "mainThreadId", "fromBotId", "fromThreadId", "withBotId", "busyBotId", "waitingForBotId", "fallbackBotId", "botIds", "threadIds"]);
const idKey = (key: string | null): boolean => key !== null && ID_KEYS.has(key);
/** A picture of My Cloud's this page shows by its address: a bot's own avatar. */
const FILE_URL_KEYS = new Set(["avatarUrl"]);
const FILE_URL = /^\/api\/attachments\/([\w-][\w.-]*)$/;
/** A link My Cloud's file route gives a <video> or <audio> element: on the conversation's own route. */
const MEDIA_URL = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/file\?media=([\w-]+)$/;
/** What a bot or a person wrote, or an engine's own words and tool calls: never rewritten, whatever keys they hold. */
const WRITTEN = new Set(["text", "widget", "app", "tool", "card", "digest", "compaction", "summary", "content", "markdown", "html", "input", "output", "args", "result",
  // A card's own data: a routine run's, a data result's, a burst's, a goal run's, a settings card's.
  "data", "extra", "dataResult", "routineRun", "burst", "goalRun", "settingsCard", "automation"]);

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? "";

type Ids = (id: string) => string;
type Way = { ids: Ids; path: (path: string) => string; url: (url: string) => string; into: boolean };

function rewrite(value: unknown, way: Way, key: string | null, depth: number): unknown {
  if (depth > 64) return value;
  if (typeof value === "string") return idKey(key) ? way.ids(value) : value;
  if (Array.isArray(value)) {
    const listOfIds = idKey(key);
    return value.map((item) => (listOfIds && typeof item === "string" ? way.ids(item) : rewrite(item, way, key === "bots" ? "bot" : key === "attachments" ? "attachment" : null, depth + 1)));
  }
  if (!record(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (WRITTEN.has(name)) { out[name] = item; continue; }
    // A bot's own id: the bot under `bot`, and each one under `bots`.
    if (name === "id" && key === "bot" && typeof item === "string") out[name] = way.ids(item);
    else if (name === "path" && (key === "attachment" || key === null && depth === 0) && typeof item === "string") out[name] = way.path(item);
    // Where a file came from on My Cloud's own disk is My Cloud's, never shown on this computer.
    else if (name === "source" && key === "attachment" && way.into) continue;
    else if (FILE_URL_KEYS.has(name) && typeof item === "string") out[name] = way.url(item);
    else if (name === "url" && depth === 0 && typeof item === "string") out[name] = way.url(item);
    else out[name] = rewrite(item, way, name, depth + 1);
  }
  return out;
}

/** My Cloud's answer as this page receives it: each bot and conversation id with My Cloud's key in front, each of its
 * files under a name this page asks for through its own server, and a media link on the conversation's place route.
 * `remember(name, path)` keeps the path My Cloud gave a file, so a request that names it names My Cloud's own path
 * again. */
export function intoPlace(value: unknown, remember: (name: string, path: string) => void = () => {}): unknown {
  const named = (name: string, path: string) => {
    if (!name || name.startsWith(PLACE_FILE_PREFIX) || !/^[\w-][\w.-]*$/.test(name)) return null;
    const placed = `${PLACE_FILE_PREFIX}${name}`;
    remember(placed, path);
    return placed;
  };
  return rewrite(value, {
    ids: placeId, into: true,
    path: (path) => named(basename(path), path) ?? path,
    url: (url) => {
      const file = FILE_URL.exec(url);
      if (file) { const placed = named(file[1]!, url); return placed ? `/api/attachments/${placed}` : url; }
      const media = MEDIA_URL.exec(url);
      return media ? `/api/threads/${encodeURIComponent(placeId(media[1]!))}/messages/${media[2]}/file?media=${media[3]}` : url;
    },
  }, null, 0);
}

/** What this page sends My Cloud, in My Cloud's own ids. `recall(name)` gives back the path a file came with. */
export function outOfPlace(value: unknown, recall: (name: string) => string | undefined = () => undefined): unknown {
  const back = (path: string) => { const name = basename(path); return name.startsWith(PLACE_FILE_PREFIX) ? recall(name) ?? path : path; };
  return rewrite(value, { ids: ownId, into: false, path: back, url: back }, null, 0);
}
