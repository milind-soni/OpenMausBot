// Human-facing copy for a bot's empty chat. A bot's description doubles as
// its system prompt, so persona prompts ("Role: You are the …") are reduced
// to a one-line role instead of being shown verbatim.

export interface BotIntro {
  summary: string | null;
  starters: string[];
}

const PERSONA = /^\s*(role\s*:|you are\b)/i;
const YOU_ARE = /\byou are (?:the |an? )?([^.\n]+)/i;

export function botSummary(description: string, title: string): string | null {
  const text = description.trim();
  if (text && !PERSONA.test(text)) return text;
  const role = text.match(YOU_ARE)?.[1]?.trim();
  if (role) return `Your ${role}.`;
  return title.trim() ? `Your ${title.trim()}.` : null;
}

const STARTERS: Array<[RegExp, string[]]> = [
  [/\b(ceo|founder|manager|pm|lead project)\b/i, [
    "Plan a roadmap for my project",
    "Break a feature into tasks for the team",
    "Summarize where our open tasks stand",
  ]],
  [/\b(develop|engineer|programm|coder)/i, [
    "Review this project's architecture",
    "Find and fix a failing test",
    "Scaffold a new feature",
  ]],
  [/\bmarket|brand|growth/i, [
    "Draft a launch announcement",
    "Write social posts for our next release",
    "Outline a campaign plan",
  ]],
  [/\b(design|ui|ux)/i, [
    "Critique a screen's layout",
    "Map the onboarding user journey",
    "Propose a color and type system",
  ]],
  [/\b(test|qa|quality|review)/i, [
    "Test a feature and list the bugs",
    "Write a QA checklist for a release",
    "Review recent changes for flaws",
  ]],
];

const DEFAULT_STARTERS = ["What can you help me with?", "Plan a small project", "Review some code"];

export function botIntro(bot: { title: string; description: string }): BotIntro {
  const haystack = `${bot.title}\n${bot.description}`;
  const starters = STARTERS.find(([pattern]) => pattern.test(bot.title))?.[1]
    ?? STARTERS.find(([pattern]) => pattern.test(haystack))?.[1]
    ?? DEFAULT_STARTERS;
  return { summary: botSummary(bot.description, bot.title), starters };
}
