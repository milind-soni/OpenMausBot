// The user-role instructions a chat turn injects between rounds (corrections, nudges) and the notes for a model that cannot see images.

export const CORRECTIVE_ROUND = "[OpenMausBot: a tool call in this turn failed (its result is marked ok:false). Re-run the failed operations with corrected inputs where possible, check the results, then give your final answer. Do not report results you did not get.]";

export const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Use your tools for only the remaining work, or reply with verified results if nothing is left to do. Never repeat an operation that succeeded, was denied, or may already have taken effect; inspect its state instead. Do not retry a destructive operation.";

export const UNREADABLE_CALL = "[OpenMausBot: your last tool call could not be read, so nothing ran. Call the tool again using only the tools you were given, with valid JSON arguments.]";

export const TEXT_ONLY_ATTACHMENT_NOTE = "[The person attached image(s), but this model cannot see images. Say so if the request depends on them.]";

export const TEXT_ONLY_SCREENSHOT_NOTE = "[Screenshot not shown: this model cannot see images. Read the page with a snapshot or a text tool instead.]";
