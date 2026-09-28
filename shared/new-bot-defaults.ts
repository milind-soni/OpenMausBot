import type { WireBot } from "./wire";
import type { RoutineInput } from "./routines";

/** Data shared by the default template and an individual creation draft. */
export type BotDefaultsProfile = Partial<Pick<WireBot,
  "name" | "title" | "description" | "soul" | "notifications" | "avatarUrl" | "avatarCrop" |
  "mascotBody" | "color" | "voice" | "speakReplies" | "section" | "modelSelection" |
  "cloudBackend" | "autoStartVps" | "approvalMode" | "alwaysAllow" | "chiefOfStaff" |
  "managedSections" | "approvePeerComms" | "composio" | "browser"
>> & {
  mascotExpression?: string | null;
  computer?: WireBot["computer"] | null;
  cwd?: string | null;
  peers?: string[] | null;
  browserProfile?: string | null;
  mcpServers?: string[] | null;
  parkDirectMessages?: boolean;
};

export type BotRoutineTemplate = Omit<RoutineInput, "botId" | "target" | "groupId" | "resultsThreadId">;
export interface BotSkillTemplate {
  name: string;
  description: string;
  source: string;
  text: string;
  enabled: boolean;
  warnings: string[];
}
export interface NewBotDefaults {
  profile: BotDefaultsProfile;
  memory: Record<string, string>;
  skills: BotSkillTemplate[];
  routines: BotRoutineTemplate[];
}
