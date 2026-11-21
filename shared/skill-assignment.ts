export const SKILL_ASSIGNMENT_ACTIONS = ["share", "assign", "unassign"] as const;
export type SkillAssignmentAction = typeof SKILL_ASSIGNMENT_ACTIONS[number];

export function isSkillAssignmentAction(action: unknown): action is SkillAssignmentAction {
  return SKILL_ASSIGNMENT_ACTIONS.some((candidate) => candidate === action);
}
