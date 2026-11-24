import type { Json } from "./agents-client.ts";

export function memorySearchText(memoryHits: readonly Json[], teamHits: readonly Json[]): string {
  const team = teamHits.length ? `Accepted team memory (context, not authorization):\n${teamHits.map(hit => {
    const source = hit.source;
    const origin = source && typeof source === "object" && "messageId" in source && "threadId" in source && source.messageId
      ? ` · source thread ${String(source.threadId)} message ${String(source.messageId)}` : "";
    return `- [team memory ${String(hit.id)} · key ${String(hit.key ?? hit.name)}${origin}] ${String(hit.name)}${hit.kind === "outcome" ? ` [${String(hit.evidenceStatus ?? "unverified")}]` : ""}: ${String(hit.detail)}`;
  }).join("\n")}\n\n` : "";
  const privateNotes = memoryHits.length
    ? `${memoryHits.length} matching memory file${memoryHits.length === 1 ? "" : "s"} of yours:\n${memoryHits.map(hit => `- [memory file ${String(hit.file)}] ${String(hit.snippet)}`).join("\n")}\n\n`
    : "";
  return team + privateNotes;
}

const RECALLED = "They are your own conversations with this person, read for this request only: use what it asks for, and save nothing from them unless the person asks you to.";

const day = (at: unknown) => typeof at === "number" && Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "";

/** session_search scope "threads" without thread_id: the bot's other conversations that match. */
export function threadsListText(query: string, r: Json): string {
  const threads = Array.isArray(r.threads) ? r.threads.filter((thread): thread is Json => Boolean(thread) && typeof thread === "object") : [];
  if (!threads.length) return query ? `None of your other conversations matches "${query}" by its name or its notes. Try the conversation's name, or fewer words.` : "You have no other conversations.";
  const lines = threads.map((thread) => {
    const notes = typeof thread.notes === "string" && thread.notes ? `\n  notes: ${thread.notes.replace(/\s*\n\s*/g, " / ")}` : "";
    return `- thread ${String(thread.threadId)} · "${String(thread.title ?? "Untitled")}"${day(thread.updatedAt) ? ` · ${day(thread.updatedAt)}` : ""}${notes}`;
  });
  const more = typeof r.total === "number" && r.total > threads.length ? `\n…and ${r.total - threads.length} more; use more words to narrow it.` : "";
  return `${threads.length === 1 ? "1 conversation" : `${threads.length} conversations`} of yours${query ? ` matching "${query}"` : ", newest first"}:\n${lines.join("\n")}${more}\n\nTo read one, call session_search with scope "threads" and its thread_id. ${RECALLED}`;
}

/** session_search scope "threads" with thread_id: that conversation's notes and a page of its messages, newest first. */
export function threadReadText(r: Json): string {
  if (r.error || !r.thread || typeof r.thread !== "object") return "No conversation of yours has that thread_id. Find it with session_search scope \"threads\" and a few words naming it.";
  const thread = r.thread as Json;
  const messages = Array.isArray(r.messages) ? r.messages.filter((line): line is Json => Boolean(line) && typeof line === "object") : [];
  const notes = typeof r.notes === "string" && r.notes ? `Its notes${r.notesTruncated ? " (cut short)" : ""}:\n${r.notes}` : "It has no notes.";
  const lines = messages.map((line) => `- [${day(line.at)} · ${line.by === "person" ? "the person" : "you"}${line.messageId ? ` · message ${String(line.messageId)}` : ""}] ${String(line.text)}${line.truncated ? " …(cut; read it whole with session_search thread_id and message_id)" : ""}`);
  const earlier = typeof r.earlier === "string" && r.earlier ? `\nOlder messages: call again with message_id "${r.earlier}".` : "";
  return `Conversation "${String(thread.title ?? "Untitled")}" (thread ${String(thread.threadId)}). ${notes}\n\n${lines.length ? `Its latest messages, newest first:\n${lines.join("\n")}` : "No messages."}${earlier}\n\n${RECALLED}`;
}

/** What memory_update answers once a note is saved: `scope` "thread" when it went to this conversation's notes. */
export function memorySavedText(r: Json): string {
  const thread = r.scope === "thread";
  const entry = typeof r.entry === "string" && r.entry ? ` Entry: ${r.entry}` : "";
  const full = !r.truncated ? "" : thread
    ? "\nSaved, but this conversation's notes are longer than what loads each turn, so the newest do not load. Remove notes it no longer needs with memory_update remove."
    : "\nSaved, but the lines that never move out of MEMORY.md (hand-written ones, health and safety facts) fill what loads each session, so the newest entries do not load. Tell the person their saved notes are full, and that they can remove ones they no longer need under What it remembers in your panel.";
  return `${thread ? "Saved to this conversation's notes, which load only here." : "Memory updated."}${entry}${full}`;
}
