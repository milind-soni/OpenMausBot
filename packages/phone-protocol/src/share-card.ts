/** A shareable template of one bot or one department, as its chat card and the department Share modal show it
 * (WireMessage.template). The template itself is a folder of files (bot.md or team.md, skills/<name>/SKILL.md,
 * avatars/<key>.<ext>) that never holds chats, memory, keys or connection addresses. */
export type TemplateStatus = "draft" | "publishing" | "published" | "failed" | "gone";
export type TemplateScope = "bot" | "department";

export interface TemplateAvatar {
  key: string;
  name: string;
  color: string;
  /** A data: URL of the bot's picture, when it has one. */
  picture?: string;
  mascotExpression?: string;
  mascotBody?: string;
}

export interface TemplateCard {
  id: string;
  scope: TemplateScope;
  name: string;
  tagline: string;
  avatars: TemplateAvatar[];
  counts: { bots: number; skills: number; routines: number; apps: number };
  /** How many key- or password-shaped values were replaced before the folder was written. */
  redacted: number;
  /** Parts left out, in plain words ("Skill pricing changed while it was being shared"). */
  skipped: string[];
  status: TemplateStatus;
  /** The GitHub folder link Import accepts; set once published. */
  link?: string;
  prUrl?: string;
  /** The last publish's one-line error. */
  error?: string;
  /** Publishing can't happen from here: no MausBot account is signed in, or the community service isn't offered. The card
   * offers Save folder… and the community repository's upload page instead of Publish. */
  fallback?: "sign_in" | "unavailable";
}

/** What a template brings, for its Details sheet and for Import's preview. Everything here is text the folder carries. */
export interface TemplateDetails {
  scope: TemplateScope;
  name: string;
  tagline: string;
  summary?: string;
  bots: Array<{
    key: string;
    name: string;
    title?: string;
    description?: string;
    instructions?: string;
    color: string;
    picture?: string;
    skills: string[];
    lead?: boolean;
  }>;
  skills: Array<{ name: string; description: string }>;
  /** Every routine arrives paused. */
  routines: Array<{ name: string; bot: string; prompt: string }>;
  /** Apps the recipient connects with their own accounts. */
  apps: Array<{ label: string; reason?: string }>;
  groupChats: Array<{ name: string; members: string[] }>;
  brief?: string;
}

/** The community repository a published template lands in, and the page anyone can upload a folder through. */
export const COMMUNITY_REPOSITORY_URL = "https://github.com/milind-soni/openmausbot-teams";
export const COMMUNITY_UPLOAD_URL = `${COMMUNITY_REPOSITORY_URL}/upload/main/teams`;

/** The chat message the bot's Share button sends, and the one Update sends. */
export const TEMPLATE_SHARE_MESSAGE = "Create a public template of yourself that I can share with somebody else";
export const TEMPLATE_UPDATE_MESSAGE = "Update your shared template.";
