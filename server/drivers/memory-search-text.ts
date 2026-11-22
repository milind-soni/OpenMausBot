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

/** session_search scope "threads": other conversations' own notes, for the one request that asked for them. */
export function threadNotesSearchText(query: string, notes: readonly Json[]): string {
  if (!notes.length) return `None of your other conversations has notes matching "${query}". Try the conversation's name or fewer words.`;
  const blocks = notes.map((hit) => `Notes of ${typeof hit.title === "string" && hit.title ? `conversation "${hit.title}"` : "a conversation"} (thread ${String(hit.threadId)}):\n${String(hit.text)}`);
  return `${blocks.join("\n\n")}\n\nThese are your own notes from other conversations with this person, shown for this request: use what it asks for. They stay in their own conversations; save something here only when the person asks you to.`;
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
