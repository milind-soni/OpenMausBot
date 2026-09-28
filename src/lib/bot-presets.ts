// Preset bots in the New bot dialog: presets from the organization and from
// imported files, above the built-in roles (server/presets.ts has the store
// and the allowlist). Choosing one fills the draft's name, look and standing
// instructions, which the person can still change. What the preset brings
// besides (skills, starter notes, playbooks) the server adds when the bot is
// created, switched on for an organization preset and off for a file's.
import { t } from "@/lib/i18n";
import type { BotDefaultsProfile } from "../../shared/new-bot-defaults";

/** GET /api/bot-presets, one entry (server/presets.ts WireBotPreset). */
export interface BotPreset {
  id: string;
  source: "file" | "org";
  key: string;
  name: string;
  description?: string;
  packageName: string;
  release: string;
  publisherName?: string;
  bot: {
    name?: string;
    title?: string;
    description?: string;
    soul?: string;
    appearance?: {
      color: NonNullable<BotDefaultsProfile["color"]>;
      mascotExpression?: string;
      mascotBody?: string;
      avatar?: { mime: "image/png" | "image/jpeg" | "image/webp"; data: string; crop: "circle" | "rounded" | "square" };
    };
  };
  skills: Array<{ name: string; description: string }>;
  skillsEnabled: boolean;
  playbooks: string[];
  notes: string[];
}

/** What the draft remembers of a chosen preset, for creation. */
export interface ChosenPreset {
  id: string;
  skills: string[];
  notes: string[];
}

export interface PresetGroup {
  label: string;
  presets: BotPreset[];
}

/** Organization presets under "From {publisher}", then imported ones, in
 * the server's order. Pure, for tests. */
export function presetGroups(presets: readonly BotPreset[]): PresetGroup[] {
  const groups: PresetGroup[] = [];
  for (const preset of presets) {
    const label = preset.source === "org"
      ? t("newBot.presetsFromOrganization", { name: preset.publisherName ?? preset.packageName })
      : t("newBot.presetsImported");
    const group = groups.find((candidate) => candidate.label === label);
    if (group) group.presets.push(preset);
    else groups.push({ label, presets: [preset] });
  }
  return groups;
}

/** The draft fields a preset fills: name, title, description, standing
 * instructions and look. Never a model, computer, folder, approval level or
 * connected apps: the preset has none, and the draft keeps its own. */
export function presetDraftPatch(preset: BotPreset): Partial<BotDefaultsProfile> {
  const patch: Partial<BotDefaultsProfile> = {
    name: preset.bot.name ?? preset.name,
    title: preset.bot.title ?? "",
    description: preset.bot.description ?? "",
    soul: preset.bot.soul ?? "",
  };
  const look = preset.bot.appearance;
  if (look) {
    patch.color = look.color;
    patch.mascotExpression = look.mascotExpression ?? null;
    if (look.mascotBody) patch.mascotBody = look.mascotBody as BotDefaultsProfile["mascotBody"];
  }
  return patch;
}

/** The preset's picture as a file the draft uploads like any chosen picture. */
export function presetPictureFile(preset: BotPreset): File | null {
  const avatar = preset.bot.appearance?.avatar;
  if (!avatar) return null;
  let binary: string;
  try {
    binary = atob(avatar.data);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], `preset.${avatar.mime.slice(6)}`, { type: avatar.mime });
}

/** The lines under the picker: where it came from and what it adds. */
export function presetSummaryLines(preset: BotPreset): string[] {
  const lines = [preset.source === "org" && preset.publisherName
    ? t("newBot.presetFromOrg", { package: preset.packageName, release: preset.release, publisher: preset.publisherName })
    : t("newBot.presetFrom", { package: preset.packageName, release: preset.release })];
  if (preset.description) lines.push(preset.description);
  const skills = preset.skills.map((skill) => skill.name).join(", ");
  if (skills) lines.push(t(preset.skillsEnabled ? "newBot.presetSkillsOn" : "newBot.presetSkillsOff", { names: skills }));
  if (preset.notes.length) lines.push(t("newBot.presetNotes", { names: preset.notes.join(", ") }));
  if (preset.playbooks.length) lines.push(t("newBot.presetPlaybooks", { names: preset.playbooks.join(", ") }));
  lines.push(t("newBot.presetKeeps"));
  return lines;
}

export function chosenPreset(preset: BotPreset): ChosenPreset {
  return { id: preset.id, skills: preset.skills.map((skill) => skill.name), notes: [...preset.notes] };
}
