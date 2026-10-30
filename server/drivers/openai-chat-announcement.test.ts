import { describe, expect, it } from "vitest";
import { announcesAction } from "./openai-chat.ts";

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
