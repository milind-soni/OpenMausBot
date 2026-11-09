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

  it("keeps a question or an approval wait at one request", () => {
    for (const text of [
      "我在 Browser 标签页读取文档，需要你先确认授权。",
      "我在 Browser 标签页读取文档，可以吗？",
      "我在 Browser 标签页读取文档，等你授权后再继续。",
    ]) expect(announcesAction(text), text).toBe(false);
  });
});
