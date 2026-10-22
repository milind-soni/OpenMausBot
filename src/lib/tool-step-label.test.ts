import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { toolStepLabel } from "./tool-step-label";

describe("toolStepLabel", () => {
  it.each([
    [{ name: "Bash", summary: "pnpm test" }, "Run a command"],
    [{ name: "pwd", summary: "pwd" }, "Run a command"],
    [{ name: "Read" }, "Read a file"],
    [{ name: "WebSearch" }, "Search the web"],
    [{ name: "mcp__omb__computer_batch" }, "Use the screen"],
    [{ name: "mcp__omb__screenshot" }, "Look at the screen"],
    [{ name: "mcp__claude_ai_Gmail__list_bots" }, "Check the team"],
    [{ name: "agent_browser_click" }, "Use the browser"],
    [{ name: "GITHUB_GET_A_COMMIT" }, "Get a commit"],
    [{ name: "mcp__composio__LINEAR_CREATE_LINEAR_COMMENT" }, "Create linear comment"],
    [{ name: "mcp__notes__query_database" }, "Query database"],
    [{ name: "NotebookRead" }, "Notebook read"],
    [{ name: "tool" }, "Use a tool"],
  ])("names %o as %s", (tool, label) => {
    expect(toolStepLabel(tool)).toBe(label);
  });

  it("names a command-titled chip as a command, not by its command line", () => {
    expect(toolStepLabel({ name: "ls -la /Users/sam/project", summary: "ls -la /Users/sam/project" })).toBe("Run a command");
  });

  it("keeps a line the server already wrote in words", () => {
    expect(toolStepLabel({ name: "Messaged @Ada" })).toBe("Messaged @Ada");
    expect(toolStepLabel({ name: "Send failed — the sending bot no longer exists" })).toBe("Send failed — the sending bot no longer exists");
  });
});

describe("a server notice on a step", () => {
  const answered = { name: "Answer passed to the waiting work", nameCode: "chat.notice.answerPassed" };
  it("is worded in the person's language with its code, and stays English without one", () => {
    setLocale("pt-br");
    try {
      expect(toolStepLabel(answered)).toBe("Resposta entregue ao trabalho que estava esperando");
      expect(toolStepLabel({ name: answered.name })).toBe(answered.name);
      expect(toolStepLabel({ name: "Answer passed", nameCode: "toolStep.runCommand" })).toBe("Answer passed");
    } finally {
      setLocale("en");
    }
  });
});
