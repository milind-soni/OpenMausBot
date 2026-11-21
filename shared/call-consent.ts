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

// Chinese has no word boundaries, so only a whole answer can decide a card.
// 嗯 mm, 呃/额 uh, 哦 oh, 啊 ah, 好/好的 okay, 好吧 all right, 行/可以 sure, 没问题 no problem.
const ZH_HEDGES = /^(?:(?:嗯+|呃|[额額]|哦|啊|好[的吧]?|行|可以|[没沒][问問][题題])[\s,，、。.!！]+)+/;
// 同意 agree, 我同意 I agree, 允许 allow, 我允许 I allow it, 批准 approve, 我批准 I approve, 是的 yes.
// 确认执行 confirm the run, 可以执行 you may run it, 允许执行 allowed to run, 同意执行 agree to run it.
// 请执行 please run it, 执行吧 go ahead and run it, 确认授权 confirm the permission.
const ZH_YES = /^(?:我?(?:同意|允[许許]|批准)|是的|(?:[确確][认認]|可以|允[许許]|同意|[请請])[执執]行|[执執]行吧|[确確][认認]授[权權])[\s。.!！]*$/;
// 拒绝 refuse, 我拒绝 I refuse, 不同意 disagree, 不允许 not allowed, 不批准 not approved.
// 不要执行 do not run it, 不执行 do not run, 取消执行 cancel the run, 取消 cancel, 停止执行 stop running.
// 不 no, 不行 no way, 不可以 you may not, 不要 don't, 不用 no need.
const ZH_NO = /^(?:我?拒[绝絕]|不同意|不允[许許]|不批准|(?:不要|不|取消|停止)[执執]行|取消|不(?:行|可以|要|用)?)[\s。.!！]*$/;

/** A Chinese answer on its own: "allow", "deny", or null. Never decides an English answer. */
export function chineseConsent(text: string): "allow" | "deny" | null {
  const said = text.trim().replace(ZH_HEDGES, "");
  if (ZH_YES.test(said)) return "allow";
  if (ZH_NO.test(said)) return "deny";
  return null;
}

/** "allow", "deny", or null when the words are not a clear decision. The
 * answer must open the utterance; filler before it ("uh, yes") is dropped.
 * `live`: a Live call, whose microphone stays open while the voice speaks
 * and which decides after a short quiet window — hedges never decide there.
 * `turns` (take turns) keeps its own rule: its microphone is closed while
 * the bot talks. */
export function spokenConsent(text: string, mode: "turns" | "live" = "turns"): "allow" | "deny" | null {
  const chinese = chineseConsent(text);
  if (chinese) return chinese;
  const said = text.trim().replace(mode === "live" ? LIVE_HEDGES : FILLER, "");
  if ((mode === "live" ? LIVE_YES : YES).test(said)) return "allow";
  if (NO.test(said)) return "deny";
  return null;
}
