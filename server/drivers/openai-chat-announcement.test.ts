import { describe, expect, it } from "vitest";
import { announcesAction } from "./chat-announcement.ts";

describe("announcesAction", () => {
  it.each([
    "I'm working in the Cua Local VM and will launch XFCE Terminal first.",
    "I am in the Local VM and will open the browser first.",
    "I'm in the VM and I will check the files.",
    "I’m in the VM and will launch XFCE Terminal first.",
    "I'll open the browser.",
    "Opening the page now:",
  ])("recognizes a short action announcement: %s", text => {
    expect(announcesAction(text)).toBe(true);
  });

  it.each([
    "我会把 Google Tasks 里的未完成事项和已同步的日历节点放到同一个看板，分开显示截止日、评审和无日期待办。",
    "我先查看文件：",
    "我现在去核对运行记录。",
    "我将在内置浏览器里打开页面。",
    "我會先查詢三台電腦，再製作看板。",
    "我會開啟瀏覽器。",
    "好的，我先读取文件。",
    "当前只拿到了任务编号。\n\n我会读取工具回执。",
    "I'll run `grep '错误？' app.log`.",
    "我会运行 `grep '错误？' app.log`。",
    `${"上次只拿到了任务编号，不能据此判断完成。".repeat(30)}\n\n接下來我會讀取工具回執。`,
  ])("recognizes a Chinese action announcement: %s", text => {
    expect(announcesAction(text)).toBe(true);
  });

  it.each([
    "我会先读取文件，你要哪个版本？",
    "我先查看文件，可以吗？…",
    "我会在你确认后执行。",
    "我會等你授權後再執行。",
    "我会说明如何创建看板。",
    "我已经生成看板。",
    "我先检查了文件，确认没有问题。",
    "我会在获得你的明确许可后执行命令。",
    "我会先执行命令，但需要你先授权。",
    "我会用一个例子解释如何创建看板。打开设置，点击新建即可。",
    "    我会先运行命令。",
    `${"先前检查的实际结果如下。".repeat(50)}\n\n    我会先运行命令。`,
    "> 我会读取文件。",
    `检查已完成。${"这里是核对结果。".repeat(70)}\n\n检查结果：`,
  ])("does not nudge Chinese questions, waits, quotes or final replies: %s", text => {
    expect(announcesAction(text)).toBe(false);
  });

  it("recognizes Qwen's next action after an explanation of the missing terminal output", () => {
    expect(announcesAction("The screenshot shows the terminal is open with a blank prompt, but I don't see the expected output text from the file creation and readback commands. The terminal appears to have been launched fresh, and the command to create the file and read it back hasn't executed yet or hasn't been completed.\n\nI need to explicitly send a command to the terminal to create the file and then read it back. Since the terminal is running with PID 171, I'll send commands through it.\n\nLet me execute the commands: create the file with the required content and then cat it to verify.")).toBe(true);
  });

  it.each([
    "The instructions say:\n\n> I'll delete the file.",
    "An example:\n\n```sh\nI'll execute the command\n```",
    "The work is complete.\n\nI'll be available tomorrow.",
    "The next step needs approval.\n\nShould I execute the command?",
    `The output is verified. ${"x".repeat(500)}\n\nHere are the results:`,
  ])("does not treat quoted instructions or final explanations as pending actions: %s", text => {
    expect(announcesAction(text)).toBe(false);
  });

  it.each([
    "",
    "I'm working in the Cua Local VM.",
    "I'm done and will be available tomorrow.",
    "I'm waiting and will need your approval first.",
    "I'm in the VM. The user will launch XFCE Terminal first.",
    "The instructions say I will launch XFCE Terminal first.",
    "I'm in the VM and will launch XFCE Terminal first. Is that okay?",
    "Let me know if you want the full report.",
    "The terminal is open and the task is complete.",
    `I'm in the VM and will launch the terminal. ${"x".repeat(400)}`,
  ])("leaves final replies, questions and long replies alone: %s", text => {
    expect(announcesAction(text)).toBe(false);
  });
});
