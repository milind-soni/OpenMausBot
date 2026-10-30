import { composioActionPhrase } from "@/lib/approval-summary";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";

type StepTool = Pick<NonNullable<Message["tool"]>, "name" | "summary" | "whose">;

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
  trigger: "toolStep.manageAutomations",
  trigger_info: "toolStep.checkAutomations",
  tool: "toolStep.useTool",
  other: "toolStep.useTool",
  mcp: "toolStep.useTool",
};

function sentence(words: string): string {
  const flat = words.replace(/\s+/g, " ").trim();
  return flat ? flat[0]!.toLocaleUpperCase() + flat.slice(1) : flat;
}

/** Whose own app or MCP server a step used, after its label: "Fetch emails · using Ada's Gmail". */
export function withWhose(label: string, tool: Pick<StepTool, "whose">): string {
  return tool.whose ? `${label} · ${t("toolStep.usingWhose", { person: tool.whose.person, app: tool.whose.app })}` : label;
}

export function toolStepLabel(tool: StepTool): string {
  return withWhose(stepWords(tool), tool);
}

function stepWords(tool: StepTool): string {
  const { name } = tool;
  // Codex and ACP title a command's chip with the command line; only a command carries a summary.
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
