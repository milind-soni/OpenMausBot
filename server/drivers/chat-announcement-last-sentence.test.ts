import { describe, expect, it } from "vitest";

import { announcesAction } from "./chat-announcement.ts";

describe("announcesAction reads a report's last sentence", () => {
  it("catches the plan a finished report ends with", () => {
    for (const text of [
      "仓库与 README 已核实：它是 DeepSeek 发布的研究原型，而非正式产品。我在 Screen 面板的 Browser 标签页读取部署和授权文档，补齐实际使用限制。",
      "我在 Screen 面板的 Browser 标签页读取部署和授权文档，补齐实际使用限制。",
      "结论如上。我接下来会打开 README 补齐细节。",
      "调研结果已整理好。我现在去把限制条件核对一遍。",
    ]) expect(announcesAction(text), text).toBe(true);
  });

  it("leaves a report that names only finished work alone", () => {
    for (const text of [
      "我在 Screen 面板的 Browser 标签页打开了页面，读完了文档。",
      "我已确认结果，报告如下：项目维护活跃。",
      "我在报告中说明了结论，供你参考。",
      "我在 Browser 标签页读取到 3 份文档，结论如上。",
      "我在这里等你。",
    ]) expect(announcesAction(text), text).toBe(false);
  });

  it("still nudges a plan whose object names finished work", () => {
    expect(announcesAction("我接下来会读取已保存的配置文件。")).toBe(true);
    expect(announcesAction("结论如上。我接下来会读取已保存的配置文件。")).toBe(true);
  });

  it("leaves a completed narrative alone", () => {
    for (const text of [
      "我在 Browser 标签页查找相关资料的过程中，发现一个问题。",
      "我在查阅官方文档的时候，看到它的授权限制很严格。",
      "我在读取日志期间，发现有三条报错。",
    ]) expect(announcesAction(text), text).toBe(false);
  });

  it("catches plans phrased the way the model actually writes them", () => {
    for (const text of [
      "我会在 Screen 面板的 Browser 标签页查今天的副业话题和同类视频，再挑一个写成可直接录制的脚本。",
      "我会查 Agents Anywhere 里 MacBook Pro 的 Codex 会话，按最近活动时间列出最新 20 条。",
      "小克，我先查找项目仓库，核对它的功能、架构、部署方式和维护情况，重点看是否适合你现有的多电脑任务调度。",
      "小克，这次重新读取项目的一手资料，给出有来源的调研结论，不把准备操作当成结果。",
      "我会在 Screen 面板的 Browser 标签页核查今天的副业、防骗和 AI 副业话题，给你 3 个可拍选题和一条完整脚本，区分已核实信息与选题建议。",
      "我按刚才的“双 11 兼职防骗”文案制作一条不露脸的竖屏成片，加上中文配音和字幕，先不发布。",
      "小克，我先核对现有成员，再新建分工明确的短视频制作 Bot，把它们拉进同一个群。已有的 ComfyUI 视频流会优先复用。",
    ]) expect(announcesAction(text), text).toBe(true);
  });

  it("leaves a recommendation and a report of what it already did alone", () => {
    for (const text of [
      "我建议你先确认授权范围，再决定要不要执行。",
      "我已按建议先去核对了运行记录，结果如下。",
      "我会说明如何创建看板，并给出每个选项的含义。",
    ]) expect(announcesAction(text), text).toBe(false);
  });

  it("keeps a question or an approval wait at one request", () => {
    for (const text of [
      "我在 Browser 标签页读取文档，需要你先确认授权。",
      "我在 Browser 标签页读取文档，可以吗？",
      "我在 Browser 标签页读取文档，等你授权后再继续。",
    ]) expect(announcesAction(text), text).toBe(false);
  });
});
