import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { cjkSearchText, cjkTokenParts, ensureSearchIndex, ftsPhrase, SEARCH_MARK, withoutSearchMarks } from "./cjk-search.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { memoryPassages, recallQuery } from "./recall.ts";
import { WORKSPACES_DIR, writeMemoryTopic } from "./workspace.ts";

const SPEC = { table: "messages", fts: "messages_fts", view: "messages_search", triggerPrefix: "messages_fts" };

describe("CJK search text", () => {
  it("splits every CJK character from its neighbours and leaves other text alone", () => {
    expect(cjkSearchText("Buy milk")).toBeNull();
    expect(cjkSearchText(null)).toBeNull();
    const indexed = cjkSearchText("iPhone15电池, 图书馆")!;
    expect(withoutSearchMarks(indexed)).toBe("iPhone15电池, 图书馆");
    expect(indexed.split(SEARCH_MARK)).toEqual(["iPhone15", "电", "池, 图", "书", "馆"]);
  });

  it("queries a CJK term as a phrase of its characters", () => {
    expect(ftsPhrase("图书馆")).toBe('"图 书 馆"');
    expect(ftsPhrase("iphone15电池")).toBe('"iphone15 电 池"');
    expect(ftsPhrase("milk")).toBe('"milk"');
  });

  it("makes bigrams of CJK runs and keeps the rest", () => {
    expect(cjkTokenParts("iphone15的电池")).toEqual({ other: ["iphone15"], bigrams: ["电池"] });
    expect(cjkTokenParts("图书馆")).toEqual({ other: [], bigrams: ["图书", "书馆"] });
  });

  it("keeps a lone Han character as its own term, never a lone kana", () => {
    expect(cjkTokenParts("猫")).toEqual({ other: [], bigrams: ["猫"] });
    expect(cjkTokenParts("猫的粮")).toEqual({ other: [], bigrams: ["猫", "粮"] });
    expect(cjkTokenParts("を")).toEqual({ other: [], bigrams: [] });
  });

  it("keeps the long vowel and half-width voicing marks inside a kana word", () => {
    expect(cjkTokenParts("コーヒー")).toEqual({ other: [], bigrams: ["コー", "ーヒ", "ヒー"] });
    expect(cjkTokenParts("ﾒｰﾙ")).toEqual({ other: [], bigrams: ["ﾒｰ", "ｰﾙ"] });
    expect(cjkTokenParts("ﾊﾞｽ")).toEqual({ other: [], bigrams: ["ﾊﾞ", "ﾞｽ"] });
    expect(cjkTokenParts("ﾊﾟﾝ")).toEqual({ other: [], bigrams: ["ﾊﾟ", "ﾟﾝ"] });
  });

  it("leaves out a stretched vowel, so a drawn-out interjection recalls nothing", () => {
    expect(cjkTokenParts("すごーーい")).toEqual({ other: [], bigrams: ["すご"] });
    expect(cjkTokenParts("ｽｺﾞｰｰｲ")).toEqual({ other: [], bigrams: ["ｽｺ", "ｺﾞ"] });
    expect(recallQuery("うーーーん")).toBeNull();
  });
});

describe("the search index", () => {
  const legacy = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, text TEXT);
      CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='unicode61');
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    db.prepare("INSERT INTO messages (id, text) VALUES (?, ?)").run("zh", "周三下午三点要去社区图书馆还书。");
    db.prepare("INSERT INTO messages (id, text) VALUES (?, ?)").run("en", "Buy milk tomorrow");
    return db;
  };
  const match = (db: DatabaseSync, query: string) =>
    (db.prepare("SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?").all(query) as Array<{ id: string }>)
      .map((row) => row.id);

  it("migrates a plain-text index so a word inside a Chinese sentence is found, and English still is", () => {
    const db = legacy();
    expect(match(db, '"图书馆"')).toEqual([]);
    ensureSearchIndex(db, SPEC);
    expect(match(db, ftsPhrase("图书馆"))).toEqual(["zh"]);
    expect(match(db, '"milk"')).toEqual(["en"]);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
  });

  it("is unchanged by a second open, and keeps writes, edits and deletes in step", () => {
    const db = legacy();
    ensureSearchIndex(db, SPEC);
    ensureSearchIndex(db, SPEC);
    db.prepare("INSERT INTO messages (id, text, search_text) VALUES (?, ?, ?)").run("new", "冰箱冷冻室设在零下十八度", cjkSearchText("冰箱冷冻室设在零下十八度"));
    expect(match(db, ftsPhrase("冷冻"))).toEqual(["new"]);
    db.prepare("UPDATE messages SET text = ?, search_text = ? WHERE id = ?").run("阳台绿萝每周浇水", cjkSearchText("阳台绿萝每周浇水"), "new");
    expect(match(db, ftsPhrase("冷冻"))).toEqual([]);
    expect(match(db, ftsPhrase("绿萝"))).toEqual(["new"]);
    db.prepare("DELETE FROM messages WHERE id = ?").run("zh");
    expect(match(db, ftsPhrase("图书"))).toEqual([]);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
  });
});

// Ordinary notes a person's assistant keeps, each asked about later in other words.
const NOTES: Array<[note: string, question: string]> = [
  ["净水器的滤芯每六个月更换一次，上次是五月初换的。", "滤芯多久要换一次？"],
  ["周三下午三点去社区图书馆还书，顺便续借阅卡。", "借的书哪天去图书馆还？"],
  ["车子的保险在明年三月到期，要提前一个月续保。", "车险什么时候到期"],
  ["牙医预约在下周五上午十点，地点是人民路口腔诊所。", "牙医预约是几点"],
  ["每月十五号自动扣视频会员费，二十五元。", "视频会员每个月扣多少钱"],
  ["妈妈的生日是农历八月十二，记得提前订蛋糕。", "我妈生日是哪天"],
  ["家里的宽带办在电信，套餐年底到期。", "宽带是哪家运营商办的"],
  ["护照有效期到2028年，办签证前要确认。", "护照什么时候过期"],
  ["公司报销需要在每月25日前提交发票。", "发票报销截止是几号"],
  ["阳台的绿萝每周浇一次水，冬天十天一次。", "绿萝多久浇水"],
  ["下个月去杭州出差，酒店订在西湖边。", "杭州出差住哪个酒店"],
  ["孩子的英语辅导班每周六上午九点上课。", "英语辅导班星期几上课"],
  ["冰箱下层的冷冻室温度设在零下十八度。", "冷冻室温度调到多少"],
  ["体检报告显示血脂偏高，医生建议少吃油炸食品。", "上次体检报告说了什么"],
  ["房租每季度交一次，房东微信是老王。", "房租怎么交"],
  ["电动车每两天充一次电，充电器放在门口柜子里。", "充电器放哪里了"],
  ["信用卡账单日是每月五号，还款日是二十三号。", "信用卡哪天还款"],
  ["狗狗的疫苗下次接种时间是十二月十号。", "狗打疫苗是什么时候"],
  ["楼下快递柜的取件码一般发到短信里。", "快递取件码在哪看"],
  ["年假还剩六天，打算春节前后一起休。", "我还有几天年假"],
];

describe("Chinese and Japanese recall", () => {
  const BOT = "bot-cjk-recall";
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("recalls a Chinese note for a paraphrased Chinese question", () => {
    NOTES.forEach(([note], i) => writeMemoryTopic(BOT, `note-${i}.md`, `${note}\n`));
    const found = NOTES.filter(([, question], i) =>
      recallQuery(question) !== null && memoryPassages(BOT, question).some((passage) => passage.label === `memory/note-${i}.md`));
    expect(found.length).toBe(NOTES.length);
    const passage = memoryPassages(BOT, "借的书哪天去图书馆还？")[0];
    expect(passage?.snippet).toContain("社区图书馆还书");
    expect(passage?.snippet).not.toContain(SEARCH_MARK);
  });

  it("recalls a note by one Han character asked on its own", () => {
    writeMemoryTopic(BOT, "cat.md", "家里的猫每天早上吃一次。\n");
    expect(memoryPassages(BOT, "猫").map((passage) => passage.label)).toContain("memory/cat.md");
  });

  it("recalls a Japanese note by a katakana word with a long vowel", () => {
    writeMemoryTopic(BOT, "coffee.md", "好きな飲み物はコーヒー、ブラックで。\n");
    expect(recallQuery("コーヒーは？")).not.toBeNull();
    expect(memoryPassages(BOT, "コーヒーは？").map((passage) => passage.label)).toContain("memory/coffee.md");
  });
});
