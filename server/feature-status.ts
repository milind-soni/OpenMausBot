import type { FeatureStatus } from "../shared/features.ts";
import { agentsToolBridgeEnabled } from "./agents-bridge-switch.ts";
import { autoRecallEnabled, builtInBrowserEnabled, claudeUserMcpEnabled, roomMemoryCaptureEnabled, sharedComputersEnabled, showToolCallsEnabled, skillAuthoringEnabled, skillReviewSteps, type AppConfig } from "./config.ts";
import { acpPlanLinesEnabled } from "./drivers/acp/session-reports.ts";
import { parallelRoomJobsEnabled } from "./host/room-jobs.ts";
import { savedStepsEnabled } from "./saved-steps/saved-steps.ts";
import { skillsLibraryEnabled } from "./skill-library.ts";
import { shareLearnedSkillsMode } from "./skill-share.ts";
import { llmThreadTitlesEnabled } from "./thread-title-generate.ts";
import { claudeUserSkillsEnabled } from "./turn-settings.ts";

export function featureStatus(cfg: AppConfig, savedStepsHere: boolean): FeatureStatus {
  return {
    skillAuthoring: skillAuthoringEnabled(cfg),
    skillReview: cfg.features?.skillReview === true,
    skillReviewSteps: skillReviewSteps(cfg),
    skillsLibrary: skillsLibraryEnabled(cfg),
    shareLearnedSkills: shareLearnedSkillsMode(cfg),
    showToolCalls: showToolCallsEnabled(cfg),
    browser: builtInBrowserEnabled(cfg),
    sharedComputers: sharedComputersEnabled(cfg),
    claudeUserMcp: claudeUserMcpEnabled(cfg),
    claudeUserSkills: claudeUserSkillsEnabled(cfg),
    autoRecall: autoRecallEnabled(cfg),
    smartSetupChoices: cfg.features?.smartSetupChoices !== false,
    acpPlanLines: acpPlanLinesEnabled(),
    agentsToolBridge: agentsToolBridgeEnabled(cfg),
    roomMemoryCapture: roomMemoryCaptureEnabled(cfg),
    parallelRoomJobs: parallelRoomJobsEnabled(cfg),
    llmThreadTitles: llmThreadTitlesEnabled(cfg),
    savedSteps: savedStepsEnabled(cfg),
    savedStepsHere,
  };
}
