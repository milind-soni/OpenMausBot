// Pins the bytes of OpenMausBot's own prompt text a turn carries: the fixed sections of a bot's system prompt, what a
// Claude turn appends with --append-system-prompt-file, and what a Codex turn sets as developer instructions. Each may
// move at most 2% either way (lower a number to lock in a win); a bigger change moves its baseline by hand.
import { describe, expect, it } from "vitest";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { codexDeveloperInstructions, syncCodexInstructions } from "./drivers/codex-instructions.ts";
import { volatileContextNote, withVolatileNote } from "./drivers/prompt-split.ts";
import { meetingsUnavailablePrompt } from "./meetings/prompt.ts";
import { REPLY_HABITS_PROMPT } from "./reply-habits.ts";
import { setupSystemPrompt } from "./setup-mode.ts";
import { computerSelectionPrompt } from "./surface.ts";
import { memoryRulesPrompt, workspaceDir } from "./workspace.ts";
import {
  AGENTS_TOOL_BRIDGE_PROMPT, CREDENTIAL_PROMPT, PROFILE_PROMPT, SIGN_IN_PROMPT, TEAM_MEMORY_PROMPT, TRIGGER_PROMPT, botPersona, buildSystemPrompt,
  computerPrompt, longCommandsPrompt, type ComputerPromptKind, type PromptPart,
} from "./system-prompt.ts";

const BOT = { id: "bot-budget", name: "Kiwi" };

/** The fixed parts every direct chat with the agents tools carries, in the order the harness builds them. */
function directChatParts(setup: boolean): PromptPart[] {
  return [
    { id: "setup", label: "Setup", text: setupSystemPrompt(setup, { skills: true, connectedApps: { state: "available" } }) },
    { id: "meetings", label: "Meetings", text: meetingsUnavailablePrompt({ agentsTools: true, cloudComputer: false }) },
    // Both used to ride the volatile note; they are the same every turn, so the stable half carries them now.
    { id: "computer-selection", label: "Choosing a computer", text: computerSelectionPrompt() },
    { id: "credential", label: "Credentials", text: CREDENTIAL_PROMPT },
    { id: "routine", label: "Triggers", text: TRIGGER_PROMPT },
    { id: "profile", label: "Profile changes", text: PROFILE_PROMPT },
    { id: "team-memory", label: "Team memory", text: TEAM_MEMORY_PROMPT },
  ];
}

const KINDS: ComputerPromptKind[] = ["vm-private", "vm-shared", "box", "vps", "local"];

async function measured(): Promise<Record<string, number>> {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const chat = buildSystemPrompt(botPersona(BOT), "", directChatParts(false));
  const setup = buildSystemPrompt(botPersona(BOT), "", directChatParts(true));
  const chief = chiefOfStaffSystemPrompt(BOT.id, [{ ...BOT, chiefOfStaff: true }] as never, true, undefined, [] as never);
  let resumed = "";
  await syncCodexInstructions("budget", "native-budget", chat.stable, "", true, async (_method, params) => {
    resumed = (params as { items: Array<{ content: Array<{ text: string }> }> }).items[0]!.content[0]!.text;
    return {};
  });
  return {
    "reply-habits": bytes(REPLY_HABITS_PROMPT),
    "tool-bridge": bytes(AGENTS_TOOL_BRIDGE_PROMPT),
    "sign-in": bytes(SIGN_IN_PROMPT),
    "chief-of-staff": bytes(chief),
    // The bot's own memory paths vary with the data folder, so they count as empty strings here.
    "memory-rules": bytes(memoryRulesPrompt(BOT.id, { managedWrites: true }).replaceAll(JSON.stringify(workspaceDir(BOT.id)).slice(0, -1), "\"")),
    ...Object.fromEntries(directChatParts(true).map((part) => [part.id, bytes(part.text)])),
    ...Object.fromEntries(KINDS.map((kind) => [`computer:${kind}`, bytes(computerPrompt(kind) + longCommandsPrompt(kind))])),
    "claude:direct-chat": bytes(chat.stable),
    "claude:setup-chat": bytes(setup.stable),
    "claude:volatile-note": bytes(withVolatileNote("", "x", true)) - 1,
    "codex:direct-chat": bytes(codexDeveloperInstructions({}, chat.stable)),
    "codex:setup-chat": bytes(codexDeveloperInstructions({}, setup.stable)),
    "codex:resumed-instructions": bytes(resumed) - bytes(chat.stable),
    "codex:volatile-note": bytes(volatileContextNote("x", false)) - 1,
  };
}

/** Bytes when the budget was last set. The direct chat's stable half now also carries "computer-selection", and a bot's
 * stable half "memory-rules" too (with its own paths), both moved out of the volatile note: 8,895 before the move and the
 * rewording (when the two rode the note, about 3,800 more bytes per conversation), 8,391 + 2,048 after. */
const PROMPT_BUDGET_BASELINE: Record<string, number> = {
  "reply-habits": 2046,
  "tool-bridge": 593,
  "sign-in": 2552,
  "chief-of-staff": 4856,
  "memory-rules": 2048,
  "setup": 2396,
  "meetings": 296,
  "computer-selection": 1269,
  "credential": 895,
  "routine": 2624,
  "profile": 931,
  "team-memory": 286,
  // Both sandbox kinds carry +130 bytes on purpose: the person's own files (C:\Users\…, /Users/…, Desktop) are reached only on This computer.
  "computer:vm-private": 5565,
  "computer:vm-shared": 5560,
  "computer:box": 4034,
  "computer:vps": 4678,
  "computer:local": 4987,
  "claude:direct-chat": 8391,
  "claude:setup-chat": 10787,
  "claude:volatile-note": 178,
  "codex:direct-chat": 8391,
  "codex:setup-chat": 10787,
  "codex:resumed-instructions": 213,
  "codex:volatile-note": 97,
};

describe("OpenMausBot's prompt text per turn", () => {
  it("stays within its pinned budget", async () => {
    const now = await measured();
    expect(Object.keys(now).sort()).toEqual(Object.keys(PROMPT_BUDGET_BASELINE).sort());
    for (const [name, baseline] of Object.entries(PROMPT_BUDGET_BASELINE)) {
      const ratio = now[name]! / baseline;
      expect(ratio, `${name}: ${now[name]} bytes against ${baseline}`).toBeGreaterThanOrEqual(0.98);
      expect(ratio, `${name}: ${now[name]} bytes against ${baseline}`).toBeLessThanOrEqual(1.02);
    }
  });
});
