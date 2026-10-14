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
