/** The phone tools a step of the phone server's batch tool can run; a batch may run only where all of them may. */
export const PHONE_STEP_TOOLS = ["open_app", "tap_text", "tap", "swipe", "type_text", "press", "read_screen"] as const;

export type PhoneStepTool = (typeof PHONE_STEP_TOOLS)[number];
