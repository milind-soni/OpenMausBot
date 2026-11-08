import type { WireBot } from "./wire";
import type { RoutineInput } from "./routines";
import type { ToolScope } from "./tool-scope";
import type { PortableFolderFile } from "./portable-skill-bundle";

/** Data shared by the default template and an individual creation draft. */
export type BotDefaultsProfile = Partial<Pick<WireBot,
  "name" | "title" | "description" | "soul" | "notifications" | "avatarUrl" | "avatarCrop" |
  "mascotBody" | "mascotFaceColor" | "color" | "voice" | "speakReplies" | "section" | "modelSelection" |
  "cloudBackend" | "autoStartVps" | "approvalMode" | "alwaysAllow" | "chiefOfStaff" |
  "managedSections" | "approvePeerComms" | "composio" | "browser" | "voiceNotes"
>> & {
  mascotExpression?: string | null;
  computer?: WireBot["computer"] | null;
  cwd?: string | null;
  peers?: string[] | null;
  browserProfile?: string | null;
  mcpServers?: string[] | null;
  toolScope?: ToolScope | null;
  parkDirectMessages?: boolean;
  helperModel?: boolean;
  /** null or absent: follows the installation's `tts.everyReply`. */
  voiceNoteEveryReply?: boolean | null;
};

export type BotRoutineTemplate = Omit<RoutineInput, "botId" | "target" | "groupId" | "resultsThreadId">;
export interface BotSkillTemplate {
  name: string;
  description: string;
  source: string;
  text: string;
  enabled: boolean;
  warnings: string[];
  files?: PortableFolderFile[];
  omittedFiles?: Array<{ path: string; reason: "skill_file_type" | "skill_file_unsafe" | "skill_file_limit" }>;
}
export interface NewBotDefaults {
  profile: BotDefaultsProfile;
  memory: Record<string, string>;
  skills: BotSkillTemplate[];
  routines: BotRoutineTemplate[];
}
