// The one sentence that asks the bot to keep a run as a skill, in plain
// words. The run card puts it at the top of the composer; the server
// recognises a turn that opens with it and expands it into the same
// skill-authoring turn as `/learn` — so nobody sees or types a slash command,
// and the renderer and the server cannot drift apart on the wording.
export const SAVE_RUN_AS_SKILL_LINE = "Save the steps below as a reusable skill for my review.";
