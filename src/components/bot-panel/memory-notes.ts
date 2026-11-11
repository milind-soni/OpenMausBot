import { MEMORY_INDEX, type MemoryDoc } from "@/lib/memory";

/** The bullet lines of MEMORY.md, each with the line it sits on so one can be taken out again. */
export interface MemoryNote {
  line: number;
  text: string;
}

const BULLET = /^\s*[-*]\s+(.+?)\s*$/;

export function memoryNotes(text: string): MemoryNote[] {
  return text.split("\n").flatMap((raw, line) => {
    const note = BULLET.exec(raw)?.[1];
    return note ? [{ line, text: note }] : [];
  });
}

export function withoutMemoryNote(text: string, line: number): string {
  const lines = text.split("\n");
  if (!BULLET.test(lines[line] ?? "")) return text;
  lines.splice(line, 1);
  return lines.join("\n");
}

export function withMemoryNote(text: string, note: string): string {
  const body = text.replace(/\s+$/, "");
  const bullet = `- ${note.trim().replace(/\s*\n\s*/g, " ")}`;
  return body ? `${body}\n${bullet}\n` : `${bullet}\n`;
}

/** A note of one file: a bullet of it, or, for a topic file without bullets, the whole file (`line` null). */
export interface PanelMemoryNote {
  path: string;
  line: number | null;
  text: string;
}

export function panelMemoryNotes(docs: readonly MemoryDoc[]): PanelMemoryNote[] {
  return docs.flatMap((doc): PanelMemoryNote[] => {
    const bullets = memoryNotes(doc.text).map((note) => ({ path: doc.path, ...note }));
    if (bullets.length || doc.path === MEMORY_INDEX) return bullets;
    const text = doc.text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).filter(Boolean).join(" ");
    return text ? [{ path: doc.path, line: null, text }] : [];
  });
}
