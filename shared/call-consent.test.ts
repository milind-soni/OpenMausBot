import { describe, expect, it } from "vitest";

import { chineseConsent, spokenConsent } from "./call-consent.ts";

describe("spokenConsent", () => {
  it("reads a clear yes or no at the start of the answer", () => {
    expect(spokenConsent("Yes, go ahead")).toBe("allow");
    expect(spokenConsent("okay")).toBe("allow");
    expect(spokenConsent("No, don't do that")).toBe("deny");
    expect(spokenConsent("cancel it")).toBe("deny");
  });

  it("drops leading filler words", () => {
    expect(spokenConsent("uh, yes")).toBe("allow");
    expect(spokenConsent("Hmm... no")).toBe("deny");
  });

  it("never reads consent from a sentence that only contains the word", () => {
    expect(spokenConsent("I'm not sure")).toBeNull();
    expect(spokenConsent("what does it want to do? sure, maybe")).toBeNull();
    expect(spokenConsent("")).toBeNull();
    expect(spokenConsent("yesterday was fine")).toBeNull();
  });

  // On a Live call the microphone stays open while the voice speaks; Take turns
  // closes it while the bot talks and keeps its rule.
  describe("on a Live call", () => {
    it("does not take a hedging okay, sure or fine as a yes", () => {
      for (const said of ["okay", "OK.", "ok", "sure", "fine", "Okay... wait, what does it delete?", "okay I need your permission to run a command"]) {
        expect(spokenConsent(said, "live"), said).toBeNull();
      }
    });

    it("still reads a clear yes or no, after a hedge or filler", () => {
      expect(spokenConsent("yes", "live")).toBe("allow");
      expect(spokenConsent("Okay, yes", "live")).toBe("allow");
      expect(spokenConsent("sure, go ahead", "live")).toBe("allow");
      expect(spokenConsent("uh, do it", "live")).toBe("allow");
      expect(spokenConsent("okay no", "live")).toBe("deny");
      expect(spokenConsent("no", "live")).toBe("deny");
      expect(spokenConsent("fine, don't", "live")).toBe("deny");
    });

    it("does not grant a qualified, corrected or questioning yes", () => {
      for (const said of ["yes, but do not delete it", "yes — wait, no", "yes, what does that delete?", "yes, only if you make a backup"]) {
        expect(spokenConsent(said, "live"), said).toBeNull();
      }
      expect(spokenConsent("Yes, go ahead.", "live")).toBe("allow");
      expect(spokenConsent("yes please", "live")).toBe("allow");
    });

    it("leaves take turns as it was", () => {
      expect(spokenConsent("okay")).toBe("allow");
      expect(spokenConsent("sure", "turns")).toBe("allow");
      expect(spokenConsent("fine")).toBe("allow");
    });
  });

  for (const mode of ["turns", "live"] as const) {
    it(`accepts a whole Chinese approval or refusal in ${mode} mode`, () => {
      for (const said of [
        "同意", "我同意", "允许", "我允许", "批准", "我批准", "是的", "确认执行", "可以执行", "允许执行", "同意执行", "请执行", "执行吧", "确认授权",
        "允許", "我允許", "確認執行", "可以執行", "允許執行", "同意執行", "請執行", "執行吧", "確認授權",
        "同意。", "同意！", " 同意 ", "可以执行.", "嗯，同意", "好的，同意。", "好，允许", "可以，执行吧", "嗯嗯 同意", "行，批准",
        "呃、额，没问题,我同意", "哦。啊！好吧.同意",
      ]) {
        expect.soft(spokenConsent(said, mode), said).toBe("allow");
      }
      for (const said of [
        "拒绝", "我拒绝", "不同意", "不允许", "不批准", "不要执行", "不执行", "取消执行", "取消", "停止执行", "不", "不行", "不可以", "不要", "不用",
        "拒絕", "我拒絕", "不允許", "不要執行", "不執行", "取消執行", "停止執行", "拒绝。", "嗯，拒绝", "好的，取消", "額，沒問題！我拒絕",
      ]) {
        expect.soft(spokenConsent(said, mode), said).toBe("deny");
      }
    });

    it(`ignores Chinese filler, questions, conditions, corrections and quotations in ${mode} mode`, () => {
      for (const said of [
        "好", "好的", "好的。", "行", "可以", "可以。", "嗯", "没问题", "同意吗", "同意吗？", "可以执行吗？", "要拒绝吗",
        "同意，但是先备份", "同意，不过别删文件", "可以执行，但只执行一次", "同意。不对，拒绝", "不，同意", "他说同意", "我不确定是否同意",
        "我需要你的同意", "请明确说同意或拒绝", "不知道", "不好意思，没听清", "同意书在哪里", "取消订单的事怎么样了",
        "好的同意", "同意，", "拒绝?", "同意？",
      ]) {
        expect(spokenConsent(said, mode), said).toBeNull();
      }
    });
  }
});

describe("chineseConsent", () => {
  it("accepts a whole Chinese approval or refusal", () => {
    for (const said of ["同意", "好的，同意。", "可以执行", "允許"]) {
      expect.soft(chineseConsent(said), said).toBe("allow");
    }
    for (const said of ["拒绝", "不行", "嗯，取消", "拒絕"]) {
      expect.soft(chineseConsent(said), said).toBe("deny");
    }
  });

  it("ignores Chinese filler, questions and conditions", () => {
    for (const said of ["好的", "可以", "同意吗？", "同意，但是先备份"]) {
      expect(chineseConsent(said), said).toBeNull();
    }
  });

  it("ignores English answers and empty input", () => {
    for (const said of ["yes", "no", "okay", "uh, yes", "uh, yes, but only after a backup", ""]) {
      expect(chineseConsent(said), said).toBeNull();
    }
  });
});
