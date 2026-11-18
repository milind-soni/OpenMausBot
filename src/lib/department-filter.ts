import type { Bot } from "@/state/store";

export const GENERAL_DEPARTMENT = "\u0000general";

export function filterableDepartments(bots: readonly Bot[], order: readonly string[]): { names: string[]; hasGeneral: boolean } {
  const visible = bots.filter((bot) => !bot.hidden);
  const used = new Set(visible.map((bot) => bot.section).filter((name): name is string => Boolean(name)));
  return { names: order.filter((name) => used.has(name)), hasGeneral: visible.some((bot) => !bot.section) };
}

export function botInDepartment(bot: Pick<Bot, "section"> | undefined, department: string): boolean {
  if (department === "all") return true;
  if (!bot) return false;
  return department === GENERAL_DEPARTMENT ? !bot.section : bot.section === department;
}
