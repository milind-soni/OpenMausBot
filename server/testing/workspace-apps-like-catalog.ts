// A synthetic connected-apps tool list shaped like Composio's Google Workspace toolkits as its MCP server lists them:
// `<TOOLKIT>_<ACTION>` names, a long description, and per-parameter title, description, examples and default. Gmail and
// Calendar tools are small, Drive, Docs and Photos tools large. All made up; deterministic.
import type { ListedTool } from "../tool-list-budget.ts";

interface Toolkit { slug: string; actions: string[]; noun: string; parameters: [number, number]; words: [number, number] }

const TOOLKITS: Toolkit[] = [
  { slug: "GMAIL", noun: "email", parameters: [1, 3], words: [12, 30], actions: ["FETCH_EMAILS", "SEND_EMAIL", "CREATE_EMAIL_DRAFT", "LIST_LABELS", "ADD_LABEL_TO_EMAIL", "GET_PROFILE", "LIST_THREADS", "MOVE_TO_TRASH", "REPLY_TO_THREAD", "FETCH_MESSAGE_BY_THREAD_ID"] },
  { slug: "GOOGLECALENDAR", noun: "event", parameters: [1, 3], words: [12, 30], actions: ["EVENTS_LIST", "CREATE_EVENT", "DELETE_EVENT", "FIND_FREE_SLOTS", "GET_CALENDAR", "LIST_CALENDARS", "QUICK_ADD", "UPDATE_EVENT"] },
  { slug: "GOOGLEDRIVE", noun: "file", parameters: [4, 12], words: [60, 140], actions: ["FIND_FILE", "FIND_FOLDER", "CREATE_FILE_FROM_TEXT", "CREATE_FOLDER", "UPLOAD_FILE", "DOWNLOAD_FILE", "COPY_FILE", "MOVE_FILE", "DELETE_FILE", "ADD_FILE_SHARING_PREFERENCE", "LIST_PERMISSIONS", "EDIT_FILE", "GET_FILE_METADATA", "LIST_SHARED_DRIVES", "CREATE_SHARED_DRIVE", "EXPORT_FILE", "LIST_COMMENTS", "CREATE_COMMENT", "LIST_REVISIONS", "UPDATE_FILE_METADATA"] },
  { slug: "GOOGLEDOCS", noun: "document", parameters: [3, 10], words: [50, 120], actions: ["CREATE_DOCUMENT", "GET_DOCUMENT_BY_ID", "UPDATE_EXISTING_DOCUMENT", "CREATE_DOCUMENT_MARKDOWN", "UPDATE_DOCUMENT_MARKDOWN", "INSERT_TABLE_ACTION", "INSERT_INLINE_IMAGE", "REPLACE_ALL_TEXT", "DELETE_CONTENT_RANGE", "CREATE_HEADER", "CREATE_FOOTER", "SEARCH_DOCUMENTS", "COPY_DOCUMENT", "LIST_NAMED_RANGES"] },
  { slug: "GOOGLEPHOTOS", noun: "media item", parameters: [3, 9], words: [50, 110], actions: ["LIST_ALBUMS", "CREATE_ALBUM", "ADD_ENRICHMENT", "BATCH_ADD_MEDIA_ITEMS", "BATCH_CREATE_MEDIA_ITEMS", "SEARCH_MEDIA_ITEMS", "GET_MEDIA_ITEM", "LIST_MEDIA_ITEMS", "UPLOAD_MEDIA", "SHARE_ALBUM", "GET_ALBUM", "UPDATE_ALBUM"] },
  { slug: "GOOGLESHEETS", noun: "spreadsheet", parameters: [3, 8], words: [40, 100], actions: ["BATCH_GET", "BATCH_UPDATE", "CREATE_GOOGLE_SHEET1", "GET_SPREADSHEET_INFO", "LOOKUP_SPREADSHEET_ROW", "SHEET_FROM_JSON", "ADD_SHEET", "CLEAR_VALUES", "APPEND_DIMENSION", "SEARCH_SPREADSHEETS"] },
];

const WORDS = "the a to of for with and when this that each its use only returns lists selected given request account item field value page token query filter order results owner shared folder document permission default optional required".split(" ");

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function sentence(next: () => number, words: number): string {
  const picked = Array.from({ length: words }, () => WORDS[Math.floor(next() * WORDS.length)]!);
  return `${picked.join(" ")}.`.replace(/^./u, (first) => first.toUpperCase());
}

function between(next: () => number, [low, high]: [number, number]): number {
  return low + Math.floor(next() * (high - low + 1));
}

/** `count` tools (at most every action of every toolkit, in toolkit order), or all of them. */
export function workspaceAppsLikeCatalog(count?: number): ListedTool[] {
  const tools: ListedTool[] = [];
  for (const [index, toolkit] of TOOLKITS.entries()) {
    for (const [position, action] of toolkit.actions.entries()) {
      const next = random(index * 1_000 + position + 1);
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const parameterCount = between(next, toolkit.parameters);
      for (let parameter = 0; parameter < parameterCount; parameter += 1) {
        const name = `${toolkit.noun.replace(/\s/gu, "_")}_${["id", "name", "query", "page_size", "page_token", "fields", "mime_type", "parent_id", "role", "type", "content", "order_by"][parameter % 12]}${parameter >= 12 ? parameter : ""}`;
        const kind = parameter % 4 === 3 ? "integer" : "string";
        properties[name] = {
          type: kind, title: name.replace(/_/gu, " "), description: sentence(next, between(next, [8, 40])),
          ...(kind === "integer" ? { default: 20, examples: [10, 50] } : { examples: [`${toolkit.noun}-example`] }),
          ...(parameter % 5 === 4 ? { enum: ["user", "group", "domain", "anyone"] } : {}),
        };
        if (parameter < 1 + (parameterCount > 6 ? 1 : 0)) required.push(name);
      }
      tools.push({
        name: `${toolkit.slug}_${action}`,
        description: `${sentence(next, between(next, toolkit.words))} ${sentence(next, 10)}`,
        inputSchema: { type: "object", title: `${action}Request`, properties, required },
      });
    }
  }
  return count === undefined ? tools : tools.slice(0, count);
}
