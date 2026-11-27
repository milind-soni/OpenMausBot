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

/** The keys whose values are a bot's or a conversation's id, or a list of them: `botId`, `threadId`, `fromThreadId`,
 * `mainThreadId`, `botIds`… Only these are rewritten, never words: a message that starts with "cloud:" stays as written. */
export const ID_KEY = /^(?:[a-z][a-zA-Z]*(?:Bot|Thread)|bot|thread)Ids?$/;
const FILE_URL = /^\/api\/attachments\/([\w.-]+)$/;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? "";

type Ids = (id: string) => string;

function rewrite(value: unknown, ids: Ids, files: (path: string) => string, key: string | null, depth: number): unknown {
  if (depth > 64) return value;
  if (typeof value === "string") {
    if (key !== null && ID_KEY.test(key)) return ids(value);
    return value;
  }
  if (Array.isArray(value)) {
    const listOfIds = key !== null && ID_KEY.test(key);
    return value.map((item) => (listOfIds && typeof item === "string" ? ids(item) : rewrite(item, ids, files, key === "bots" ? "bot" : key === "attachments" ? "attachment" : null, depth + 1)));
  }
  if (!record(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    // A bot's own id: the bot under `bot`, and each one under `bots`.
    if (name === "id" && key === "bot" && typeof item === "string") out[name] = ids(item);
    else if (name === "path" && key === "attachment" && typeof item === "string") out[name] = files(item);
    else if (typeof item === "string" && FILE_URL.test(item)) out[name] = files(item);
    else out[name] = rewrite(item, ids, files, name, depth + 1);
  }
  return out;
}

/** My Cloud's answer as this page receives it: each bot and conversation id with My Cloud's key in front, and each of
 * its files under a name this page asks for through its own server. `remember(name, path)` keeps the path My Cloud
 * gave a file, so a message sent back that names it names My Cloud's own path again. */
export function intoPlace(value: unknown, remember: (name: string, path: string) => void = () => {}): unknown {
  const files = (path: string) => {
    const at = FILE_URL.exec(path);
    const name = at ? at[1]! : basename(path);
    if (!name || name.startsWith(PLACE_FILE_PREFIX)) return path;
    const placed = `${PLACE_FILE_PREFIX}${name}`;
    remember(placed, path);
    return at ? `/api/attachments/${placed}` : placed;
  };
  return rewrite(value, placeId, files, null, 0);
}

/** What this page sends My Cloud, in My Cloud's own ids. `recall(name)` gives back the path a file came with. */
export function outOfPlace(value: unknown, recall: (name: string) => string | undefined = () => undefined): unknown {
  const files = (path: string) => {
    const name = basename(path);
    return name.startsWith(PLACE_FILE_PREFIX) ? recall(name) ?? path : path;
  };
  return rewrite(value, ownId, files, null, 0);
}
