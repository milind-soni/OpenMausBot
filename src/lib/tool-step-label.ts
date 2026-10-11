// What a tool step is called where a person reads it. A provider names its
// tools for the model: `Bash`, `mcp__omb__computer_batch`,
// `GITHUB_GET_A_COMMIT`, or (Codex, ACP) the whole command line. Simple mode
// shows a short plain phrase instead. Advanced mode and the step's own
// details keep the provider's name, so nothing a power user reads is lost.
import { composioActionPhrase } from "@/lib/approval-summary";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";

type StepTool = Pick<NonNullable<Message["tool"]>, "name" | "summary">;

/** Bare tool names (an MCP server prefix already removed) a person has a
 * phrase for. Lower-cased, so `Read`, `read` and `read_file` meet here. */
const STEP_KEYS: Record<string, LocaleKey> = {
  bash: "toolStep.runCommand",
  shell: "toolStep.runCommand",
  terminal: "toolStep.runCommand",
  run_command: "toolStep.runCommand",
  execute: "toolStep.runCommand",
  computer_exec: "toolStep.runCommand",
  read: "toolStep.readFile",
  read_file: "toolStep.readFile",
  view: "toolStep.readFile",
  write: "toolStep.writeFile",
  create_file: "toolStep.writeFile",
  edit: "toolStep.editFile",
  multiedit: "toolStep.editFile",
  str_replace: "toolStep.editFile",
  apply_patch: "toolStep.editFile",
  notebookedit: "toolStep.editFile",
  delete: "toolStep.deleteFile",
  grep: "toolStep.searchFiles",
  glob: "toolStep.searchFiles",
  find: "toolStep.searchFiles",
  search: "toolStep.searchFiles",
  ls: "toolStep.searchFiles",
  websearch: "toolStep.searchWeb",
  web_search: "toolStep.searchWeb",
  webfetch: "toolStep.openWebPage",
  web_fetch: "toolStep.openWebPage",
  fetch: "toolStep.openWebPage",
  open_url: "toolStep.openWebPage",
  screenshot: "toolStep.lookAtScreen",
  computer_screenshot: "toolStep.lookAtScreen",
  click: "toolStep.useComputer",
  type_text: "toolStep.useComputer",
  press_key: "toolStep.useComputer",
  scroll: "toolStep.useComputer",
  computer_batch: "toolStep.useComputer",
  todowrite: "toolStep.updatePlan",
  update_plan: "toolStep.updatePlan",
  task: "toolStep.askHelper",
  agent: "toolStep.askHelper",
  think: "toolStep.think",
  list_bots: "toolStep.checkTeam",
  tool: "toolStep.useTool",
  other: "toolStep.useTool",
  mcp: "toolStep.useTool",
};

function sentence(words: string): string {
  const flat = words.replace(/\s+/g, " ").trim();
  return flat ? flat[0]!.toLocaleUpperCase() + flat.slice(1) : flat;
}

/** A tool's own name as a short phrase: "Run a command", "Read a file",
 * "Get a commit" for GITHUB_GET_A_COMMIT. A name that is already words (a
 * server-written line such as "Messaged @Ada") is kept as it is. */
export function toolStepLabel(tool: StepTool): string {
  const { name } = tool;
  // Codex and ACP title a command's chip with the command itself, and only a
  // command carries a summary (server/tool-summary.ts commandSummary).
  if (tool.summary) return t("toolStep.runCommand");
  if (/\s/.test(name)) return name;
  const bare = name.replace(/^mcp__.+?__(?=.)/, "");
  if (/(?:^|_)browser_/i.test(bare)) return t("toolStep.useBrowser");
  const key = STEP_KEYS[bare.toLowerCase()];
  if (key) return t(key);
  const composio = composioActionPhrase(bare);
  if (composio) return sentence(composio);
  const words = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:]+/g, " ")
    .toLowerCase();
  return sentence(words) || t("toolStep.useTool");
}
