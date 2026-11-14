export const WELCOME_VERSION = 1;
export const ONBOARDING_CLOUD_HINT = "onboarding-cloud-v1";

export function onboardingHints(config) {
  const record = config && typeof config === "object" && config.onboarding && typeof config.onboarding === "object" ? config.onboarding : {};
  return Array.isArray(record.hintsSeen) ? record.hintsSeen.filter(hint => typeof hint === "string") : [];
}
