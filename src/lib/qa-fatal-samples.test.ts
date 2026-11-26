// @vitest-environment happy-dom
import { describe, expect, it, beforeAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown, ensureChatKatex } from "@/components/ChatMarkdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  remarkStrictMath,
  remarkMathGuard,
  rehypeSafeKatex,
} from "./markdown-math-defense";

function renderDirectDefense(text: string): string {
  return renderToStaticMarkup(
    createElement(Markdown, {
      children: text,
      remarkPlugins: [remarkGfm, remarkStrictMath, remarkMathGuard],
      rehypePlugins: [[rehypeSafeKatex, { strict: false }]],
    })
  );
}

function renderChat(text: string): string {
  return renderToStaticMarkup(createElement(ChatMarkdown, { text }));
}

describe("QA 物理法庭独立核验: 致命样本 A/B/C 全链路断言", () => {
  beforeAll(async () => {
    await ensureChatKatex();
  });

  describe("样本 A: 孤立尾 $ 符号防护", () => {
    const sampleA = "成本为 1,500\\text{ t}$，应控制在 $\\le 120$ 以内。";

    it("Direct Defense 渲染: 零红字、无跨句吞噬、正文完好", () => {
      const html = renderDirectDefense(sampleA);

      // 1. 物理零红字绝对断言
      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");
      expect(html).not.toContain("color: #cc0000");

      // 2. 正文结构完整保留，绝无跨句吞噬
      expect(html).toContain("成本为 1,500");
      expect(html).toContain("，应控制在");
      expect(html).toContain("以内。");

      // 3. 有效公式 $\\le 120$ 正常进入 KaTeX 渲染
      expect(html).toContain("katex");
    });

    it("ChatMarkdown 组件渲染: 零红字、无跨句吞噬、正文完好", () => {
      const html = renderChat(sampleA);

      // 1. 物理零红字
      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");
      expect(html).not.toContain("color: #cc0000");

      // 2. 正文结构完好
      expect(html).toContain("成本为 1,500");
      expect(html).toContain("，应控制在");
      expect(html).toContain("以内。");

      // 3. 有效公式正常渲染
      expect(html).toContain("katex");
    });
  });

  describe("样本 B: 金额与跨行标题混合", () => {
    const sampleB = "单价 $1,500，总计 $2,800\n\n# 第二章 结论\n\n需 $\\alpha > 0$";

    it("Direct Defense 渲染: H1 结构不破坏、金额原样显示、公式正常", () => {
      const html = renderDirectDefense(sampleB);

      // 1. 绝无红字
      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");

      // 2. 金额符号原样输出，不被配对为公式
      expect(html).toContain("$1,500");
      expect(html).toContain("$2,800");

      // 3. H1 标题标签结构完整保留
      expect(html).toMatch(/<h1[^>]*>第二章 结论<\/h1>/);

      // 4. 行内公式 $\\alpha > 0$ 正常渲染
      expect(html).toContain("katex");
    });

    it("ChatMarkdown 组件渲染: H1 结构不破坏、金额原样显示、公式正常", () => {
      const html = renderChat(sampleB);

      // 1. 绝无红字
      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");

      // 2. 金额符号原样输出
      expect(html).toContain("$1,500");
      expect(html).toContain("$2,800");

      // 3. 标题结构完整保留 (ChatMarkdown 将 h1 渲染为 md-heading 节点)
      expect(html).toContain("md-heading");
      expect(html).toContain("第二章 结论");

      // 4. 行内公式正常渲染
      expect(html).toContain("katex");
    });
  });

  describe("样本 C: KaTeX 语法错误/未闭合静默降级沙箱", () => {
    it("样本 C1 (花括号不平衡): 词法/AST 拦截，绝无红字", () => {
      const sampleC1 = "$\\foo{bar$ 与 $\\frac{1}{$$\n\n正文正常";
      const html = renderChat(sampleC1);

      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");
      expect(html).not.toContain("color: #cc0000");
      expect(html).toContain("正文正常");
    });

    it("样本 C2 (未知宏/语法错误): L4 沙箱优雅降级为 katex-fallback，绝无红字", () => {
      const sampleC2 = "$\\unknownLaTeXMacroThatDoesNotExist{123}$";
      const html = renderChat(sampleC2);

      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");
      expect(html).not.toContain("color: #cc0000");
      // 降级为 safe fallback
      expect(html).toContain("katex-fallback");
    });

    it("样本 C3 (未闭合 $$ 遇到 Markdown 块级元素): 绝不贪婪吞噬后续段落", () => {
      const sampleC3 = "$$\n未闭合公式块\n\n| 列1 | 列2 |\n| :--- | :--- |\n| A | B |\n\n> 引用块内容";
      const html = renderChat(sampleC3);

      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");
      // 表格和引用块必须正常渲染为 DOM 元素，不能被吞噬进公式中
      expect(html).toContain("<table");
      expect(html).toContain("<blockquote");
    });
  });
});
