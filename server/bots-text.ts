// The text of bots.json, kept as one serialized string per bot so a save that names its owners serializes only those.
// Bots change in place all over the store and nothing here is told of it, so a narrowed text is only built while the
// list holds the same bot objects in the same places as at the last write; anything else serializes every bot.
// Known open risk: a change made in place to a bot no save named is missing from a narrowed text, and is written by the
// next whole serialization (at most a moment later), so a crash in between loses it. A change to what a bot may do is
// the exception: every bot's safety digest is compared on each narrowed text.
import { botSafetyDigest } from "./bot-safety-digest.ts";
import type { BotRecord } from "./store.ts";

export class BotsText {
  private readonly persisted: (bot: BotRecord) => unknown;
  private bots: readonly BotRecord[] = [];
  private texts: string[] = [];
  private digests: string[] = [];
  private known = false;
  private readonly named = new Set<string>();

  constructor(persisted: (bot: BotRecord) => unknown) {
    this.persisted = persisted;
  }

  /** `id`'s record or one of its threads changed: the next narrowed text serializes it again. */
  name(id: string): void {
    this.named.add(id);
  }

  forget(): void {
    this.known = false;
  }

  canNarrow(bots: readonly BotRecord[]): boolean {
    if (!this.known || bots.length !== this.bots.length) return false;
    for (let i = 0; i < bots.length; i++) if (bots[i] !== this.bots[i]) return false;
    return true;
  }

  /** JSON.stringify of the persisted list, byte for byte. `narrow` (after canNarrow) serializes only the named bots;
   * `commit` once the text is on disk makes it the last write. */
  build(bots: readonly BotRecord[], narrow: boolean): { text: string; commit: () => void } {
    const texts: string[] = narrow ? this.texts.slice() : [];
    const digests: string[] = [];
    for (let i = 0; i < bots.length; i++) {
      digests[i] = botSafetyDigest(bots[i]!);
      if (!narrow || this.named.has(bots[i]!.id) || digests[i] !== this.digests[i]) texts[i] = JSON.stringify(this.persisted(bots[i]!));
    }
    const named = [...this.named];
    return {
      text: `[${texts.join(",")}]`,
      commit: () => {
        this.bots = bots.slice();
        this.texts = texts;
        this.digests = digests;
        this.known = true;
        for (const id of named) this.named.delete(id);
      },
    };
  }
}
