import { describe, expect, it } from "vitest";
import { isPureLeakedSystemHarnessMessage, stripLeakedSystemHarnessMessages } from "./system-message-guard.ts";

describe("system-message-guard", () => {
  it("leaves ordinary conversational text alone", () => {
    const text = "Hello! Here is the summary of your task.";
    expect(stripLeakedSystemHarnessMessages(text)).toBe(text);
    expect(isPureLeakedSystemHarnessMessage(text)).toBe(false);
  });

  it("handles null and undefined safely", () => {
    expect(stripLeakedSystemHarnessMessages(null)).toBe("");
    expect(stripLeakedSystemHarnessMessages(undefined)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(null)).toBe(false);
    expect(isPureLeakedSystemHarnessMessage(undefined)).toBe(false);
  });

  it("strips raw leaked background task notifications", () => {
    const leaked = `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE> [Message] timestamp=2026-10-10T18:01:21Z
sender=a3cf0f98-46dc-449c-9867-68dfa3d6d3db/task-1457
priority=MESSAGE_PRIORITY_HIGH content=Task id "a3cf0f98-46dc-449c-9867-68dfa3d6d3db/task-1457" finished with result:

The command exited with code 0. Stdout:

Stderr:

Log:
file:///Users/jsmhh/.openmausbot/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/a3cf0f98-46dc-449c-9867-68dfa3d6d3db/.system_generated/tasks/task-1457.log </SYSTEM_MESSAGE>`;

    expect(stripLeakedSystemHarnessMessages(leaked)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(leaked)).toBe(true);
  });

  it("preserves genuine assistant text while stripping leaked system block", () => {
    const mixed = `I've started building the feature for you.

The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE> Task id 123 finished with exit code 0 </SYSTEM_MESSAGE>

Everything compiled successfully and all tests pass!`;

    const cleaned = stripLeakedSystemHarnessMessages(mixed);
    expect(cleaned).toContain("I've started building the feature for you.");
    expect(cleaned).toContain("Everything compiled successfully and all tests pass!");
    expect(cleaned).not.toContain("<SYSTEM_MESSAGE>");
    expect(cleaned).not.toContain("Task id 123");
    expect(isPureLeakedSystemHarnessMessage(mixed)).toBe(false);
  });

  it("strips unclosed system tags during streaming / truncation", () => {
    const unclosed = `The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE> [Message] timestamp=2026-10-10T18:00:00Z task still in progress`;

    expect(stripLeakedSystemHarnessMessages(unclosed)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(unclosed)).toBe(true);
  });

  it("strips historical turn summary echoes with square brackets", () => {
    const text = "这是前言。[What Writer did in an earlier turn: · tools: Bash x1 · reply: Cut.] 这是后续内容。";
    const cleaned = stripLeakedSystemHarnessMessages(text);
    expect(cleaned).toBe("这是前言。这是后续内容。");
    expect(isPureLeakedSystemHarnessMessage("[What Writer did in an earlier turn: · tools: Bash x1 · reply: Cut.]")).toBe(true);
  });

  it("strips historical turn summary echoes with parentheses and nested parens", () => {
    const text = "文档整理完成。(What MausBot首席幕僚长 did in an earlier turn: · tools: agents_coordinate_bots x1 (from tool previews) · reply: 已调用【文档版本员】...)请查阅。";
    const cleaned = stripLeakedSystemHarnessMessages(text);
    expect(cleaned).toBe("文档整理完成。请查阅。");
  });

  it("strips internal from-metadata tags like (From @... (bot) · ...]", () => {
    const text = "任务已派发。(From @文档版本员 (bot) · report · information only — done] 请查看知识库。";
    const cleaned = stripLeakedSystemHarnessMessages(text);
    expect(cleaned).toBe("任务已派发。请查看知识库。");
    expect(isPureLeakedSystemHarnessMessage("(From @文档版本员 (bot) · report · information only — done]")).toBe(true);
  });

  it("strips unclosed truncated from-metadata tags at the end of message", () => {
    const text = "正在排版落盘。(From @文档版本员 (bot) · report · informati…";
    const cleaned = stripLeakedSystemHarnessMessages(text);
    expect(cleaned).toBe("正在排版落盘。");
  });

  it("strips naked bot coordination JSON structures", () => {
    const text = '已完成调度。{"bot":"文档版本员","task":"写入文档","result":"写入完成\\n内容已落盘"} 查看大纲。';
    const cleaned = stripLeakedSystemHarnessMessages(text);
    expect(cleaned).toBe("已完成调度。查看大纲。");
    expect(isPureLeakedSystemHarnessMessage('{"bot":"文档版本员","task":"写入文档","result":"ok"} ')).toBe(true);
  });

  it("preserves genuine JSON and coordination keywords inside markdown code blocks", () => {
    const text = `以下是返回的示例配置：
\`\`\`json
{
  "bot": "文档版本员",
  "task": "写入文档",
  "result": "写入完成"
}
\`\`\`
以及行内代码 \`{"bot": "demo", "result": "ok"}\`。请仔细核对。`;

    const cleaned = stripLeakedSystemHarnessMessages(text);
    expect(cleaned).toContain(`\`\`\`json
{
  "bot": "文档版本员",
  "task": "写入文档",
  "result": "写入完成"
}
\`\`\``);
    expect(cleaned).toContain('`{"bot": "demo", "result": "ok"}`');
    expect(cleaned).toContain("以下是返回的示例配置：");
    expect(cleaned).toContain("请仔细核对。");
  });

  it("purifies real-world multi-telemetry user leaked case cleanly", () => {
    const raw = "正在调用系统工具定位 Obsidian 知识库路径，并将商业化战略文档整理落盘。已调用【文档版本员】正在将《认知操作系统商业化全景战略与财务模型精算》文档编排并写入 Obsidian 知识库，写入完成后将为你提供本地文件索引与内容大纲。(What MausBot首席幕僚长 did in an earlier turn: · tools: agents_coordinate_bots ×1 (from tool previews) · reply: 已调用【文档版本员】正在将《认知操作系统商业化全景战略与财务模型精算》文档编排并写入 Obsidian 知识库，写入完成后将为你提供本地文件索引与内容大纲。)(From @文档版本员 (bot) · report · informati…";
    const expected = "正在调用系统工具定位 Obsidian 知识库路径，并将商业化战略文档整理落盘。已调用【文档版本员】正在将《认知操作系统商业化全景战略与财务模型精算》文档编排并写入 Obsidian 知识库，写入完成后将为你提供本地文件索引与内容大纲。";
    const cleaned = stripLeakedSystemHarnessMessages(raw);
    expect(cleaned).toBe(expected);
  });

  it("preserves markdown list indentation and nested hierarchy without crushing spaces", () => {
    const md = `- Item 1
  - Nested Item 1.1
    - Deep Nested Item 1.1.1
- Item 2
  1. Ordered Subitem 2.1
  2. Ordered Subitem 2.2`;
    const cleaned = stripLeakedSystemHarnessMessages(md);
    expect(cleaned).toBe(md);
  });

  it("preserves indented code blocks with 4 leading spaces", () => {
    const md = `Here is an indented code block:

    const a = 1;
    const b = 2;
    return a + b;

Finished.`;
    const cleaned = stripLeakedSystemHarnessMessages(md);
    expect(cleaned).toBe(md);
  });

  it("preserves markdown trailing double spaces for hard line breaks", () => {
    const md = `Line 1 with hard break  \nLine 2 continues here`;
    const cleaned = stripLeakedSystemHarnessMessages(md);
    expect(cleaned).toBe(md);
  });

  it("preserves markdown table alignment and column spacing", () => {
    const md = `| Header 1    | Header 2      |
|-------------|---------------|
| Value 1     | Short         |
| Longer Val  | Another Value |`;
    const cleaned = stripLeakedSystemHarnessMessages(md);
    expect(cleaned).toBe(md);
  });

  it("preserves GFM task list checkboxes without deleting empty brackets", () => {
    const md = `- [ ] Unchecked task item
- [x] Completed task item
- [ ] Another pending item`;
    const cleaned = stripLeakedSystemHarnessMessages(md);
    expect(cleaned).toBe(md);
  });

  it("fixes protection inversion: preserves system tags and unclosed tags when inside code blocks", () => {
    const codeWithSystemTags = `Here is how the prompt injection harness works:
\`\`\`xml
<SYSTEM_MESSAGE>
This is documentation explaining the system tag.
Notice: This is a <SYSTEM_NOTIFICATION> inside code block.
\`\`\`
And here is unclosed tag in inline code \`<SYSTEM_MESSAGE> [Message]\`.`;

    const cleaned = stripLeakedSystemHarnessMessages(codeWithSystemTags);
    expect(cleaned).toContain("<SYSTEM_MESSAGE>");
    expect(cleaned).toContain("This is documentation explaining the system tag.");
    expect(cleaned).toContain("Notice: This is a <SYSTEM_NOTIFICATION> inside code block.");
    expect(cleaned).toContain("` <SYSTEM_MESSAGE> [Message]`".replace(" ", ""));
  });

  it("strips injected telemetry while keeping surrounding markdown list hierarchy intact", () => {
    const input = `[From @MausBot首席幕僚长 · assignment test · on their behalf at your level]
- Feature implementation
  - Core algorithm
    - Step 1: isolate code
    - Step 2: remove ranges
  - Verification pass
{"bot":"测试质保员","task":"运行测试","result":"通过"}`;

    const expected = `- Feature implementation
  - Core algorithm
    - Step 1: isolate code
    - Step 2: remove ranges
  - Verification pass`;

    const cleaned = stripLeakedSystemHarnessMessages(input);
    expect(cleaned).toBe(expected);
  });
  it("preserves consecutive fenced code blocks without blank lines", () => {
    const input = '```json\n{"bot":"one","result":"ok"}\n```\n```json\n{"bot":"two","result":"ok"}\n```';
    expect(stripLeakedSystemHarnessMessages(input)).toBe(input);
  });

  it("preserves 4-space indented code blocks containing coordination JSON", () => {
    const input = 'Here is an example:\n\n    {"bot":"demo","task":"test","result":"ok"}\n\nDone.';
    expect(stripLeakedSystemHarnessMessages(input)).toBe(input);
  });
});
