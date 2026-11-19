export const purposes = ["Development", "Design", "Research", "Finance", "Custom"] as const;
export type Purpose = typeof purposes[number];
export type BuddyModel = { instanceId: string; model: string };
export type ProposedBuddy = {
  id: string;
  name: string;
  title: string;
  description: string;
  reason: string;
  modelSelection: BuddyModel | null;
};

const specialists: Record<Exclude<Purpose, "Custom">, [string, string, string, string]> = {
  Development: ["Kit", "Developer", "Implement scoped changes and document how to verify them.", "Builds and maintains the software."],
  Design: ["Mira", "Product Designer", "Explore concepts, design workflows, and document interaction decisions.", "Turns requirements into usable designs."],
  Research: ["Sage", "Research Analyst", "Find primary sources, compare evidence, and summarize open questions.", "Provides evidence for decisions."],
  Finance: ["Ellis", "Finance Analyst", "Organize numbers, build forecasts, and make assumptions explicit.", "Connects decisions to their financial impact."],
};

export function proposeTeam(focus: Purpose[], customGoal: string, modelSelection: BuddyModel | null): ProposedBuddy[] {
  const custom = customGoal.trim();
  const specialist = focus.filter((purpose) => purpose !== "Custom").map((purpose) => specialists[purpose]);
  const entries = [
    ["Ari", "Project Lead", `Break work into milestones and coordinate the team around ${focus[0] === "Custom" ? custom : focus[0]?.toLowerCase() ?? "the workspace goal"}.`, "Keeps priorities and handoffs clear."],
    ...specialist,
    ...(focus.includes("Custom") ? [["Rin", "Workflow Specialist", `Build a repeatable workflow for this goal: ${custom}`, "Focuses on the workflow you described."]] : []),
    ["Quinn", "Reviewer", "Check deliverables against requirements, verify important assumptions, and flag gaps.", "Catches issues before you share the work."],
  ];
  return entries.map(([name, title, description, reason]) => ({
    id: crypto.randomUUID(), name, title, description, reason, modelSelection,
  }));
}

export const tourKey = "gbs-alpha-tour";
export const tourEvent = "gbs:open-tour";
