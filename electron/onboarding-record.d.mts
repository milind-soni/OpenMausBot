/** The first-run welcome's version: a record that finished an older one shows the welcome again. */
export declare const WELCOME_VERSION: number;
/** The welcome's Cloud beat, recorded when it is shown, so a later Cloud pitch need not repeat it at once. */
export declare const ONBOARDING_CLOUD_HINT: string;
/** The hints a workspace's `onboarding` record in its config.json keeps, read by main too; anything malformed reads as none. */
export declare function onboardingHints(config: unknown): string[];
