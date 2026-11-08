import { blankCode } from "../../shared/skill-command.ts";

const CHINESE_WAIT = /(?:确认|確認|授权|授權|批准|同意|许可|許可)之?[后後]|(?:等(?:待)?|待)[你您]|(?:需要|请|請|须|須)[你您]先?(?:确认|確認|授权|授權|批准|同意)/u;

const VERB = "打[开開]|開啟|[读讀]取|查[询詢看找]|[检檢]查|[执執]行|[运運]行|[创創]建|生成|整理|保存|[写寫]入|搜[索尋]|[获獲]取|[调調]用|[处處]理|核[对對实實]|[制製]作|建立|更新|拉取|同步|导出|匯出|汇总|彙總|[发發]送";

const OPENER = /^(?:(?:好的|收到)[，,。]\s*)?(?:(?:接下[来來]|下一步)[，,]?\s*)?(?:我(?:[会會将將]|先|[现現]在|[马馬]上|立刻)|[让讓]我)(?:[会會将將]|先|立即|直接|就|去|[来來]|[开開]始){0,3}\s*/u;

const ACTION = new RegExp(`^(?:在[^。！？?，、\n]{1,40}?(?:里|裡|中|上))?(?:${VERB}|把[^。！？?\n]{1,160}?(?:放[到进進入]|做成|整理|保存|[写寫]入|[制製]作|生成|汇总|彙總))`, "u");

/** A report can end with the plan in its last sentence, after the work it reports: "…已核实。我在 Browser 标签页读取文档，补齐限制。"
 * Only this sentence is read, and only while it names no finished work, so a completed answer is left alone. */
const LAST_SENTENCE_OPENER = /^(?:(?:好的|收到)[，,。]\s*)?(?:我(?:接下[来來])?(?:[会會将將]|先|[现現]在|正在|在|[马馬]上|立刻)|(?:接下[来來]|下一步)[，,]?\s*我(?:[会會将將]|先)|[让讓]我)(?:[会會将將]|先|立即|直接|就|去|[来來]|[开開]始){0,3}\s*/u;

/** "我会说明如何创建看板" explains the action instead of promising it; only the promise is nudged. */
const EXPLAINING = /(?:如何|怎麼|怎么|怎样|怎樣|是否)/u;

const LAST_SENTENCE_ACTION = new RegExp(`^[^。！？?\n]{0,60}?(?:${VERB})`, "u");

const FINISHED = new RegExp(`(?:已经|已經)|(?:^|[^未没沒])已|(?:${VERB})(?:了|过|過|完|到|出)`, "u");

function announcesChineseAction(prose: string): boolean {
  const tail = prose.trim().split(/\n\s*\n/).at(-1)!.trim();
  if (tail.length > 400) return false;
  const opening = OPENER.exec(tail);
  if (opening) {
    const action = tail.slice(opening[0].length);
    const match = ACTION.exec(action);
    if (match && !/^[了过過完]/u.test(action.slice(match[0].length))) return true;
  }
  const sentence = tail.split(/(?<=[。！])/u).map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  if (sentence.length < 8 || sentence.length > 220 || FINISHED.test(sentence)) return false;
  const lead = LAST_SENTENCE_OPENER.exec(sentence);
  if (!lead) return false;
  const promise = sentence.slice(lead[0].length);
  return !EXPLAINING.test(promise) && LAST_SENTENCE_ACTION.test(promise);
}

export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 4_000 || reply.includes("?")) return false;
  if (/[？\p{Script=Han}]/u.test(reply)) {
    const prose = blankCode(text);
    if (prose.includes("？") || CHINESE_WAIT.test(prose)) return false;
    if (announcesChineseAction(prose)) return true;
  }
  if (reply.length > 400) {
    const tail = reply.split(/\n\s*\n/).at(-1)!.trim();
    return tail.length <= 400 && /^(?:let me|i['\u2019]ll|i will|i(?:['\u2019]m| am) going to)\s+(?:now\s+)?(?:execute|send|type|press|launch|open|check|inspect|read|fetch|run|create|write|verify)\b/i.test(tail);
  }
  return /(?:[:\u2014\u2013]|\.\.\.|\u2026)$/.test(reply) ||
    /^(?:checking|let me(?! know\b)|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading))\b/i.test(reply) ||
    /^i(?:['\u2019]m| am)\b[^.!?\n]*\band (?:i )?will\s+(?:launch|open|check|pull|look|search|navigate|read|fetch|load|run|inspect)\b/i.test(reply);
}
