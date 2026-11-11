import { z } from "zod";

/** Editable workspace features. Omitted values retain each feature's runtime default; unknown keys are discarded. */
export const featureConfigSchema = z.object({
  skillAuthoring: z.boolean().optional(),
  skillReview: z.boolean().optional(),
  skillReviewSteps: z.number().int().min(3).max(100).optional(),
  showToolCalls: z.boolean().optional(),
  browser: z.boolean().optional(),
  sharedComputers: z.boolean().optional(),
  claudeUserMcp: z.boolean().optional(),
  claudeUserSkills: z.boolean().optional(),
  llmThreadTitles: z.boolean().optional(),
  smartSetupChoices: z.boolean().optional(),
  autoRecall: z.boolean().optional(),
  skillsLibrary: z.boolean().optional(),
  shareLearnedSkills: z.enum(["off", "ask", "auto"]).optional(),
  roomMemoryCapture: z.boolean().optional(),
  parallelRoomJobs: z.boolean().optional(),
  acpPlanLines: z.boolean().optional(),
  agentsToolBridge: z.boolean().optional(),
  savedSteps: z.boolean().optional(),
});

export type FeatureConfig = z.output<typeof featureConfigSchema>;

export const FEATURE_DEFAULTS: Required<FeatureConfig> = {
  skillAuthoring: true,
  skillReview: false,
  skillReviewSteps: 10,
  showToolCalls: false,
  browser: true,
  sharedComputers: false,
  claudeUserMcp: false,
  claudeUserSkills: false,
  llmThreadTitles: false,
  smartSetupChoices: true,
  autoRecall: true,
  skillsLibrary: false,
  shareLearnedSkills: "ask",
  roomMemoryCapture: false,
  parallelRoomJobs: false,
  acpPlanLines: false,
  agentsToolBridge: false,
  savedSteps: true,
};

/** Effective feature values reported by the server, including its read-only saved-steps capability. */
export type FeatureStatus = Required<FeatureConfig> & { readonly savedStepsHere: boolean };
