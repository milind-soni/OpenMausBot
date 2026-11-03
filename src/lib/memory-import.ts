// Settings → Import → "Bring your memory from another assistant": what is saved where. The facts go into About you,
// which every bot reads; the whole import is a topic note in MausBot's memory, so it can set the person's old setup up
// here with them.
import { aboutMeWithImport, memoryImportNote, memoryImportNotePath, type MemoryImport } from "../../shared/memory-import";
import { saveTeamProfile } from "./own-profile";
import { api, type Bot, type ConfigStatus } from "@/state/store";

/** The person's own MausBot: the one bot that is theirs alone. */
export const mausBotOf = (bots: readonly Bot[]): Bot | undefined => bots.find((bot) => bot.defaultBot && !bot.hidden) ?? bots.find((bot) => bot.defaultBot);

export interface MemoryImportChoice {
  imported: MemoryImport;
  source: string;
  aboutMe: string;
  /** About you is the signed-in person's own on a Team Cloud, the server's profile anywhere else. */
  team: boolean;
  addFacts: boolean;
  /** MausBot's id when the note is wanted. */
  noteFor: string | null;
  today: string;
}

export interface MemoryImportDone { factsAdded: number; factsLeftOut: number; aboutMe: string | null; note: string | null }

export async function applyMemoryImport(choice: MemoryImportChoice): Promise<MemoryImportDone> {
  let aboutMe: string | null = null;
  let factsAdded = 0, factsLeftOut = 0;
  if (choice.addFacts && choice.imported.facts.length) {
    const merged = aboutMeWithImport(choice.aboutMe, choice.imported.facts, choice.source, choice.today);
    factsAdded = merged.added;
    factsLeftOut = merged.leftOut;
    if (merged.added) {
      const saved = choice.team
        ? await saveTeamProfile({ aboutMe: merged.text })
        : (await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { aboutMe: merged.text } }), timeoutMs: 10_000 })).profile;
      aboutMe = saved?.aboutMe ?? merged.text;
    }
  }
  let note: string | null = null;
  if (choice.noteFor) {
    note = memoryImportNotePath(choice.source);
    await api(`/api/bots/${choice.noteFor}/memory/file`, {
      method: "PUT", body: JSON.stringify({ path: note, text: memoryImportNote(choice.imported, choice.source, choice.today) }),
    });
  }
  return { factsAdded, factsLeftOut, aboutMe, note };
}

/** What MausBot is asked once the import is saved: to go through the old setup and offer to make each part here. */
export function setUpAgainMessage(source: string, imported: MemoryImport): string {
  const names = imported.setup.map((item) => item.name).join(", ");
  return `I brought my memory over from ${source}. It's in your note "What ${source} knew". Please go through my setup there (${names}) and help me set up each one here, one at a time, asking me before you create anything.`;
}

export async function askMausBotToSetUp(bot: Bot, source: string, imported: MemoryImport): Promise<void> {
  await api(`/api/bots/${bot.id}/messages`, {
    method: "POST", body: JSON.stringify({ text: setUpAgainMessage(source, imported), threadId: bot.threadId, sendId: crypto.randomUUID() }),
  });
}
