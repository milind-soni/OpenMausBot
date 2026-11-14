import type { Bot } from "@/state/store";

export interface SpokenGroupMessage {
  text: string;
  addressed: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apple dictation returns “Atlas, …” rather than “@Atlas …”. */
export function routeSpokenGroupMessage(text: string, members: Bot[]): SpokenGroupMessage {
  const trimmed = text.trim();
  if (!trimmed) return { text: "", addressed: false };

  if (/(?:^|\s)@everyone\b/i.test(trimmed)) return { text: trimmed, addressed: true };
  const explicitlyMentioned = members.some((member) => {
    const tag = new RegExp("(?:^|\\s)@" + escapeRegExp(member.name) + "(?=\\s|[,.!?:;]|$)", "i");
    return tag.test(trimmed);
  });
  if (explicitlyMentioned) return { text: trimmed, addressed: true };

  const everyone = trimmed.match(/^(?:hey\s+)?(?:everyone|everybody|all)(?:[\s,:-]+(.*))?$/i);
  if (everyone) {
    const rest = everyone[1]?.trim();
    return { text: rest ? "@everyone " + rest : "@everyone", addressed: true };
  }

  const candidates = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const member of candidates) {
    const addressed = trimmed.match(
      new RegExp("^(?:hey\\s+)?" + escapeRegExp(member.name) + "(?:[\\s,:-]+(.*))?$", "i"),
    );
    if (!addressed) continue;
    const rest = addressed[1]?.trim();
    return { text: rest ? "@" + member.name + " " + rest : "@" + member.name, addressed: true };
  }

  return { text: trimmed, addressed: false };
}
