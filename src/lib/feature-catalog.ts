import type { FeatureConfig } from "../../shared/features";
import type { AppSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";

export const FEATURE_DOCS = "https://github.com/milind-soni/OpenMausBot/blob/main/docs/feature-flags.md";


export interface FeatureCatalogEntry {
  labelKey: LocaleKey;
  descriptionKey: LocaleKey;
  keywords: readonly string[];
  documentation: string;
  anchor: string;
  editable: boolean;
  controlSection?: AppSettingsSection;
}

export const FEATURE_CATALOG: Record<keyof FeatureConfig, FeatureCatalogEntry> = {
  skillAuthoring: {
    labelKey: "settings.features.skillAuthoring.label", descriptionKey: "settings.features.skillAuthoring.description",
    keywords: ["learn", "learning", "draft", "record"], controlSection: "experimental", editable: false,
    anchor: "feature-skillAuthoring", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  skillReview: {
    labelKey: "settings.features.skillReview.label", descriptionKey: "settings.features.skillReview.description",
    keywords: ["learn", "review", "automatic"], controlSection: "skills", editable: false,
    anchor: "feature-skillReview", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  skillReviewSteps: {
    labelKey: "settings.features.skillReviewSteps.label", descriptionKey: "settings.features.skillReviewSteps.description",
    keywords: ["steps", "interval", "review", "threshold"], controlSection: "skills", editable: false,
    anchor: "feature-skillReviewSteps", documentation: `${FEATURE_DOCS}#other-values-under-features`,
  },
  showToolCalls: {
    labelKey: "settings.features.showToolCalls.label", descriptionKey: "settings.features.showToolCalls.description",
    keywords: ["tool calls", "transcript", "commands", "tools"], controlSection: "appearance", editable: false,
    anchor: "feature-showToolCalls", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  browser: {
    labelKey: "settings.features.browser.label", descriptionKey: "settings.features.browser.description",
    keywords: ["browser", "web", "chrome"], controlSection: "computer", editable: false,
    anchor: "feature-browser", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  sharedComputers: {
    labelKey: "settings.features.sharedComputers.label", descriptionKey: "settings.features.sharedComputers.description",
    keywords: ["lend", "sharing", "paired", "remote computer"], editable: false,
    anchor: "feature-sharedComputers", documentation: `${FEATURE_DOCS}#ordinary-server-lending-has-three-states`,
  },
  claudeUserMcp: {
    labelKey: "settings.features.claudeUserMcp.label", descriptionKey: "settings.features.claudeUserMcp.description",
    keywords: ["claude", "mcp", "tools", "import"], controlSection: "features", editable: false,
    anchor: "feature-claudeUserMcp", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  claudeUserSkills: {
    labelKey: "settings.features.claudeUserSkills.label", descriptionKey: "settings.features.claudeUserSkills.description",
    keywords: ["claude", "skills", "import"], controlSection: "features", editable: false,
    anchor: "feature-claudeUserSkills", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  llmThreadTitles: {
    labelKey: "settings.features.llmThreadTitles.label", descriptionKey: "settings.features.llmThreadTitles.description",
    keywords: ["title", "name", "thread", "llm"], editable: true,
    anchor: "feature-llmThreadTitles", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  smartSetupChoices: {
    labelKey: "settings.features.smartSetupChoices.label", descriptionKey: "settings.features.smartSetupChoices.description",
    keywords: ["setup", "choices", "suggestions", "onboarding"], editable: true,
    anchor: "feature-smartSetupChoices", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  autoRecall: {
    labelKey: "settings.features.autoRecall.label", descriptionKey: "settings.features.autoRecall.description",
    keywords: ["memory", "recall", "remember", "context"], editable: true,
    anchor: "feature-autoRecall", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  skillsLibrary: {
    labelKey: "settings.features.skillsLibrary.label", descriptionKey: "settings.features.skillsLibrary.description",
    keywords: ["skills", "library", "assign", "skill.md"], editable: true,
    anchor: "feature-skillsLibrary", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  shareLearnedSkills: {
    labelKey: "settings.features.shareLearnedSkills.label", descriptionKey: "settings.features.shareLearnedSkills.description",
    keywords: ["learned", "sharing", "ask", "auto", "off"], controlSection: "skills", editable: false,
    anchor: "feature-shareLearnedSkills", documentation: `${FEATURE_DOCS}#other-values-under-features`,
  },
  roomMemoryCapture: {
    labelKey: "settings.features.roomMemoryCapture.label", descriptionKey: "settings.features.roomMemoryCapture.description",
    keywords: ["room", "memory", "learn", "capture"], editable: true,
    anchor: "feature-roomMemoryCapture", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  parallelRoomJobs: {
    labelKey: "settings.features.parallelRoomJobs.label", descriptionKey: "settings.features.parallelRoomJobs.description",
    keywords: ["room", "parallel", "jobs", "concurrent"], editable: true,
    anchor: "feature-parallelRoomJobs", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  acpPlanLines: {
    labelKey: "settings.features.acpPlanLines.label", descriptionKey: "settings.features.acpPlanLines.description",
    keywords: ["acp", "plan", "activity", "progress"], editable: true,
    anchor: "feature-acpPlanLines", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  agentsToolBridge: {
    labelKey: "settings.features.agentsToolBridge.label", descriptionKey: "settings.features.agentsToolBridge.description",
    keywords: ["bridge", "tool bridge", "find_tool", "use_tool", "search", "context"], editable: true,
    anchor: "feature-agentsToolBridge", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
  savedSteps: {
    labelKey: "settings.features.savedSteps.label", descriptionKey: "settings.features.savedSteps.description",
    keywords: ["saved", "steps", "repeat", "replay", "computer"], controlSection: "general", editable: false,
    anchor: "feature-savedSteps", documentation: `${FEATURE_DOCS}#boolean-switches`,
  },
};
