import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  hasIllegalCJK,
  isBracesBalanced,
  remarkStrictMath,
  remarkMathGuard,
  rehypeSafeKatex,
} from "./markdown-math-defense";

function renderMarkdown(text: string): string {
  return renderToStaticMarkup(
    createElement(Markdown, {
      children: text,
      remarkPlugins: [remarkGfm, remarkStrictMath, remarkMathGuard],
      rehypePlugins: [[rehypeSafeKatex, { strict: false }]],
    })
  );
}

describe("Markdown/LaTeX 四层渲染防腐体系 (v1.0)", () => {
  describe("单元契约验证: hasIllegalCJK & isBracesBalanced", () => {
    it("准确识别未受文本宏保护的 CJK 字符", () => {
      // 非法 CJK：直接出现汉字或全角符号
      expect(hasIllegalCJK("1,500\\text{ t}（单条 CLI 或 \\le 120")).toBe(true);
      expect(hasIllegalCJK("x + 汉字 + y")).toBe(true);
      expect(hasIllegalCJK("a + b = 测试")).toBe(true);
      expect(hasIllegalCJK("alpha ＋ beta")).toBe(true);

      // 合法 CJK：全部被标准文本宏包裹
      expect(hasIllegalCJK("\\text{成本} \\le 120")).toBe(false);
      expect(hasIllegalCJK("\\mathrm{净收益} = W_p \\cdot \\Delta C")).toBe(false);
      expect(hasIllegalCJK("\\mbox{样本} \\in S")).toBe(false);
      expect(hasIllegalCJK("E = mc^2")).toBe(false);
    });

    it("准确识别花括号是否严格平衡", () => {
      expect(isBracesBalanced("{a + b}")).toBe(true);
      expect(isBracesBalanced("\\frac{1}{2}")).toBe(true);
      expect(isBracesBalanced("\\text{foo{bar}baz}")).toBe(true);
      expect(isBracesBalanced("{a + b")).toBe(false);
      expect(isBracesBalanced("a + b}")).toBe(false);
      expect(isBracesBalanced("}{")).toBe(false);
      expect(isBracesBalanced("\\{ not closed")).toBe(true); // 转义花括号不计入
    });
  });

  describe("标准验收用例 TC-01 ~ TC-07 物理实测", () => {
    it("TC-01: 孤立尾符号与行内公式混排（零红字、零跨句吞噬、正常排版）", () => {
      const text = "核心结论：成本为 1,500\\text{ t}$（单条 CLI 或 $\\le 120$ 行切片即可闭环）。应控制在 $\\le 120$ 以内。";
      const html = renderMarkdown(text);

      // 绝无红色错误块
      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("color:#cc0000");
      expect(html).not.toContain("color: #cc0000");

      // 正文内容完整保留，未被吞噬
      expect(html).toContain("核心结论：成本为 1,500");
      expect(html).toContain("单条 CLI 或");
      expect(html).toContain("行切片即可闭环");

      // 合法公式正常渲染
      expect(html).toContain("katex");
    });

    it("TC-02: 货币符号密集场景（防止货币被误配对为公式）", () => {
      const prices = "Jan −$3,000 · Feb −$2,000 · Avg ≈ $2,200 and $5 vs $10";
      const html = renderMarkdown(prices);

      // 绝不生成 KaTeX 节点
      expect(html).not.toContain("katex");
      expect(html).not.toContain("katex-error");
      // 文本原样完整输出
      expect(html).toContain("Jan −$3,000 · Feb −$2,000 · Avg ≈ $2,200 and $5 vs $10");
    });

    it("TC-03: 代码块中的美元符号（围栏代码块内部 $ 纯字面量）", () => {
      const text = [
        "```ts",
        "const price = '$5';",
        "const total = '$10';",
        "```",
        "",
        "行内代码 `$variable` 同样不被公式干扰。",
      ].join("\n");
      const html = renderMarkdown(text);

      expect(html).not.toContain("katex-error");
      expect(html).toContain("<code");
      expect(html).toContain("const price =");
      expect(html).toContain("$5");
      expect(html).toContain("$variable");
    });

    it("TC-04: 多行公式与列表缩进嵌套（Display Math in List 结构完好）", () => {
      const text = [
        "- **加权净收益方程**：",
        "  $$\\text{NetQuotaROI} = W_p \\cdot \\Big[\\Delta C_{\\text{dirty}}\\Big]$$",
        "  - **同级模型临界点**（Flash 派发 Flash，缓存系数 $\\alpha = 0.10$）：剩余 5 轮时临界点为 **$13,500\\text{ tokens}$**",
      ].join("\n");
      const html = renderMarkdown(text);

      expect(html).not.toContain("katex-error");
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>");
      expect(html).toContain("<strong>加权净收益方程</strong>");
      expect(html).toContain("<strong>同级模型临界点</strong>");
      expect(html).toContain("katex");
    });

    it("TC-05: 表格内嵌公式（Table with Math 结构完整不破损）", () => {
      const text = [
        "| 指标 | 目标公式 | 状态 |",
        "| :--- | :--- | :--- |",
        "| 收益 | $\\Delta C \\le 120$ | 达标 |",
        "| 容差 | $\\pm 5\\%$ | 正常 |",
      ].join("\n");
      const html = renderMarkdown(text);

      expect(html).not.toContain("katex-error");
      expect(html).toContain("<table>");
      expect(html).toContain("指标");
      expect(html).toContain("达标");
      expect(html).toContain("katex");
    });

    it("TC-06: 语法错误/非法 TeX 零红字降级沙箱（Malformed LaTeX Fallback）", () => {
      // 1. 花括号不平衡：词法阶段直接熔断拦截为文本，绝不生成红字
      const text1 = "$\foo{bar$ 与 $\\frac{1}{$";
      const html1 = renderMarkdown(text1);
      expect(html1).not.toContain("katex-error");
      expect(html1).not.toContain("color:#cc0000");
      expect(html1).not.toContain("color: #cc0000");

      // 2. 未知宏或非法语法：KaTeX 解析抛错，L4 沙箱安全捕获并降级为 normal fallback span，绝无红字
      const text2 = "$\\unknownCommandTest{xyz}$";
      const html2 = renderMarkdown(text2);
      expect(html2).not.toContain("katex-error");
      expect(html2).not.toContain("color:#cc0000");
      expect(html2).not.toContain("color: #cc0000");
      expect(html2).toContain("katex-fallback");
    });

    it("TC-07: 包含 CJK 汉字的伪公式熔断（CJK in Math without Text Macro）", () => {
      const text = "$a + 汉字测试 + b$ 以及 $\\text{中文合法} + x$";
      const html = renderMarkdown(text);

      expect(html).not.toContain("katex-error");
      // $a + 汉字测试 + b$ 词法/AST熔断，未被当成 KaTeX 处理
      expect(html).toContain("$a + 汉字测试 + b$");
      // $\text{中文合法} + x$ 包含合法的 \text{} 宏，正常渲染
      expect(html).toContain("katex");
    });
  });
});
