import { blankCode } from "../../shared/skill-command.ts";

const CHINESE_WAIT = /(?:确认|確認|授权|授權|批准|同意|许可|許可)之?[后後]|(?:等(?:待)?|待)[你您]|(?:需要|请|請|须|須)[你您]先?(?:确认|確認|授权|授權|批准|同意)/u;

const VERB = "打[开開]|開啟|核查|[检檢]查|查[询詢看找]?|[读讀]取|核[对對实實]|[确確]認|确认|[执執]行|[运運]行|[创創]建|新建|生成|整理|保存|[写寫][入明]?|搜[索尋]|[获獲]取|[调調]用|[处處]理|[制製]作|建立|更新|拉取|同步|导出|匯出|汇总|彙總|[发發]送|分析|瀏覽|浏览|访问|添加|列出|挑选|選擇|选择|对比|比較|评估|排查|诊断|部署|安装|配置|测试|验证|备份|恢复|抓取|收集|統計|统计|記錄|记录|提交|邀請|邀请|翻譯|翻译|總結|总结|提煉|提炼|录制|剪辑|发布|下载|上传";

/** The report may address the person first: "小克，我先核对现有成员…". */
const VOCATIVE = "(?:[^\\s，,。！？?：:]{1,6}[，,：:]\\s*)?";
const OPENER = new RegExp(`^${VOCATIVE}(?:(?:好的|收到)[，,。]\\s*)?(?:(?:接下[来來]|下一步)[，,]?\\s*)?(?:我(?:[会會将將]|先|[现現]在|[马馬]上|立刻)|[让讓]我)(?:[会會将將]|先|立即|直接|就|去|[来來]|[开開]始){0,3}\\s*`, "u");

const ACTION = new RegExp(`^(?:在[^。！？?，、\n]{1,40}?(?:里|裡|中|上))?(?:${VERB}|把[^。！？?\n]{1,160}?(?:放[到进進入]|做成|整理|保存|[写寫]入|[制製]作|生成|汇总|彙總))`, "u");

/** A report can end with the plan in its last sentence, after the work it reports: "…已核实。我在 Browser 标签页读取文档，补齐限制。"
 * Only this sentence is read, and only while it names no finished work, so a completed answer is left alone. */
/** A plan says who will do it or when: "我先…", "这次…", "小克，接下来…". A report that merely describes the past
 * starts differently ("已核实…", "结果是…"), so it is left alone. */
const LAST_SENTENCE_LEAD = new RegExp(`^${VOCATIVE}(?:(?:接下[来來]|下一步|然后|稍后|稍後|马上|馬上|这就|這次|这次|這輪|这轮|今天|现在|現在|先|再)(?:[，,]?\\s*(?:我|我们|我們|让我|讓我))?|(?:我|我们|我們|让我|讓我))`, "u");

/** "我会说明如何创建看板" explains the action instead of promising it; only the promise is nudged. */
const EXPLAINING = /(?:如何|怎麼|怎么|怎样|怎樣)/u;

/** The verb, with what leads up to it captured so the words right before it can say whether it already happened. */
const LAST_SENTENCE_ACTION = new RegExp(`^[^。！？?\\n]{0,60}?(${VERB})`, "u");
const COMPLETED_BEFORE = /(?:已经|已經|已|刚刚|剛剛|刚|刚才|剛才)\s*$/u;
const COMPLETED_AFTER = /^[了过過完到出]/u;
/** "我建议你先确认" recommends the work instead of promising it. */
const RECOMMENDING = /(?:建议|建議|推荐|推薦|认为|認為|觉得|覺得|主张|主張|最好|不如|应该|應該)[^。！？?，、]{0,6}?$/u;

/** A narrative says a step happened on the way to a finding; only the plan is nudged. */
const NARRATIVE = /(?:的过程中|的過程|的时候|的時候|期间|期間|以后|以後|之后|之後|时，|時，)/u;

function announcesChineseAction(prose: string): boolean {
  const tail = prose.trim().split(/\n\s*\n/).at(-1)!.trim();
  if (tail.length > 400) return false;
  const opening = OPENER.exec(tail);
  if (opening) {
    const action = tail.slice(opening[0].length);
    const match = ACTION.exec(action);
    if (match && !/^[了过過完]/u.test(action.slice(match[0].length))) return true;
  }
  // The plan is usually the last sentence, and sometimes the one before it when the report closes on a short aside:
  // "…拉进同一个群。已有的视频流会优先复用。"
  const sentences = tail.split(/(?<=[。！])/u).map((part) => part.trim()).filter(Boolean).slice(-2).reverse();
  return sentences.some((sentence) => {
    if (sentence.length < 8 || sentence.length > 220 || NARRATIVE.test(sentence)) return false;
    const lead = LAST_SENTENCE_LEAD.exec(sentence);
    if (!lead) return false;
    const promise = sentence.slice(lead[0].length);
    if (!promise || EXPLAINING.test(promise)) return false;
    const verb = LAST_SENTENCE_ACTION.exec(promise);
    if (!verb) return false;
    // Only what sits right before or after the verb says whether it already happened: `读取到` and `打开了` are done,
    // `我按建议先去核对` recommends, while what is read may itself be described as already saved (`读取已保存的配置`)
    // and still be work left to do.
    const before = promise.slice(0, verb[0].length - verb[1].length);
    if (COMPLETED_BEFORE.test(before) || RECOMMENDING.test(before)) return false;
    return !COMPLETED_AFTER.test(promise.slice(verb[0].length));
  });
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
