// Spoken answers to a permission card, shared by both call modes. Anything
// else is read as a reply to the bot, not as consent — an approval must
// never be granted by a sentence that merely contained the word "sure".
export const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
export const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;

const FILLER = /^(?:(?:um+|uh+|er+|so|well|hmm+)[\s,.!?-]+)+/i;
/** On a Live call these only hedge: "okay…" then a pause then "wait, what
 * does it delete?", a bystander's "okay", or the voice's own "Okay, I need
 * your permission" heard back through a phone's speaker. They are filler
 * there, never the answer; a clear yes or no after them still counts. */
const LIVE_HEDGES = /^(?:(?:um+|uh+|er+|so|well|hmm+|ok|okay|sure|fine)(?:[\s,.!?-]+|$))+/i;
// A Live approval grants the entire action on the card. Extra conditions,
// questions or corrections are not permission for that unchanged action.
const LIVE_YES = /^(?:yes|yeah|yep|yup|go ahead|do it|allow(?: it)?|approve(?: it)?|approved|please do)(?:[\s,]+(?:please|go ahead|do it))*[.!]*$/i;

/** "allow", "deny", or null when the words are not a clear decision. The
 * answer must open the utterance; filler before it ("uh, yes") is dropped.
 * `live`: a Live call, whose microphone stays open while the voice speaks
 * and which decides after a short quiet window — hedges never decide there.
 * `turns` (take turns) keeps its own rule: its microphone is closed while
 * the bot talks. */
export function spokenConsent(text: string, mode: "turns" | "live" = "turns"): "allow" | "deny" | null {
  const said = text.trim().replace(mode === "live" ? LIVE_HEDGES : FILLER, "");
  if ((mode === "live" ? LIVE_YES : YES).test(said)) return "allow";
  if (NO.test(said)) return "deny";
  return null;
}
