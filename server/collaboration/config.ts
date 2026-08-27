export const OPENMAUSBOT_SOURCE_BASELINE = "741772505499a6c72ba462dec635966f39737914";

/**
 * The first milestone deliberately starts fail-closed. Later tickets may add
 * implementations for these capabilities, but merely upgrading the service
 * must never enable them.
 */
export const FIRST_MILESTONE_DEFAULTS = Object.freeze({
  executionMode: "observe" as const,
  singleOwner: true,
  headlessAuthority: true,
  multiAgentConcurrency: false,
  integrationBranch: false,
  durableApprovals: false,
  previewDeployment: false,
  defaultBranchMerge: false,
  productionDeployment: false,
});

export type FirstMilestoneDefaults = typeof FIRST_MILESTONE_DEFAULTS;
