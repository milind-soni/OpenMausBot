import { describe, expect, it } from "vitest";

import { draftWorkflow, layerLabel } from "./draft.ts";
import { renderWorkflowSkillMd, workflowSchema, workflowSkillName } from "./format.ts";
import { burgerLayers, type RunMessage } from "./layers.ts";
import { cleanSummary, summaryPrompt } from "./summary.ts";

let n = 0;
const ask = (text: string): RunMessage => ({ id: `u${++n}`, role: "user", kind: "text", text });
const tool = (name: string, input: unknown, extra: Partial<NonNullable<RunMessage["tool"]>> = {}): RunMessage => ({
  id: `m${++n}`, role: "bot", kind: "activity",
  tool: { name, ok: true, input: typeof input === "string" ? input : JSON.stringify(input), ...extra },
});
const multi = (slug: string, args: unknown, output?: unknown) =>
  tool("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: slug, arguments: args }] }, output === undefined ? {} : { output: JSON.stringify(output) });

describe("where each step ran", () => {
  it("leaves out the app's own status rows", () => {
    const run = [ask("Archive it"), tool("recovery: Automatic recovery: trying Backup once in this thread.", {}), tool("notice: The model changed.", {}), tool("Bash", { command: "cp a.csv archive/" }, { summary: "cp a.csv archive/" })];
    expect(burgerLayers(run).map((layer) => layer.kind)).toEqual(["shell"]);
  });

  it("marks apps, the browser, the bot's own commands, the cloud computer and the person's computer", () => {
    const run = [
      ask("Archive the report and post it"),
      multi("GMAIL_SEND_EMAIL", { recipient_email: "priya@example.com", subject: "Report" }),
      tool("mcp__browser__browser_navigate", { url: "https://example.com/report" }),
      tool("Bash", { command: "cp report.csv archive/report.csv" }, { summary: "cp report.csv archive/report.csv" }),
      tool("mcp__agents__vm_exec", { command: "python3 make_report.py" }),
      tool("mcp__computer__exec", { command: "mkdir -p /home/cua/out" }),
      tool("mcp__computer__open_url", { url: "https://sheets.example.com/x" }),
      tool("mcp__localComputer__click", { x: 10, y: 20 }),
    ];
    expect(burgerLayers(run).map((layer) => [layer.kind, layer.where])).toEqual([
      ["app", "app"], ["browser", "browser"], ["shell", "bot"], ["shell", "vm"], ["shell", "vm"], ["browser", "vm"], ["computer", "yourComputer"],
    ]);
  });

  it("drops looks at a desktop, and joins its clicks and typing into one step the AI does again", () => {
    const run = [
      ask("Fill the form on the cloud computer"),
      tool("mcp__computer__screenshot", {}),
      tool("mcp__computer__click", { x: 100, y: 200 }),
      tool("mcp__computer__type_text", { text: "Acme Ltd" }),
      tool("mcp__computer__key_press", { key: "Return" }),
      tool("mcp__computer__screenshot", {}),
      multi("GMAIL_SEND_EMAIL", { recipient_email: "priya@example.com", subject: "Done" }),
    ];
    const layers = burgerLayers(run);
    expect(layers.map((layer) => [layer.kind, layer.where, layer.words])).toEqual([
      ["computer", "vm", "click, type text, key press"], ["app", "app", "send email"],
    ]);
    expect(layers[0]!.replay).toBe("ai");
    expect((layers[0]!.args as { actions: unknown[] }).actions).toHaveLength(3);
    const { workflow } = draftWorkflow(run)!;
    expect(workflow.steps[0]).toMatchObject({ kind: "ai", where: "vm" });
    expect((workflow.steps[0] as { prompt: string }).prompt).toContain("on the cloud computer");
    expect(workflowSchema.safeParse(workflow).success).toBe(true);
    expect(renderWorkflowSkillMd("fill-form", workflow)).toContain("on the cloud computer");
  });

  it("saves a cloud computer command to run there again, exactly", () => {
    const run = [ask("Make the report"), tool("mcp__computer__exec", { command: "python3 make_report.py" }), tool("Bash", { command: "cp out.pdf ~/Reports/" }, { summary: "cp out.pdf ~/Reports/" })];
    const { workflow } = draftWorkflow(run)!;
    expect(workflow.steps.map((step) => [step.kind, step.where])).toEqual([["shell", "vm"], ["shell", "bot"]]);
  });
});

describe("burger layers", () => {
  it("keeps real steps and drops looking around, tool searches and replaced failures", () => {
    const run = [
      ask("Email the sales sheet to priya@example.com"),
      tool("Bash", { command: "ls -la" }, { summary: "ls -la" }),
      tool("mcp__composio__COMPOSIO_SEARCH_TOOLS", { queries: ["sheets"] }),
      multi("GOOGLESHEETS_BATCH_GET", { spreadsheet_id: "1AbCdEf", ranges: ["A1:C9"] }),
      { ...multi("GMAIL_SEND_EMAIL", { recipient_email: "priya@example.com" }), tool: { name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", ok: false, input: JSON.stringify({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] }) } },
      multi("GMAIL_SEND_EMAIL", { recipient_email: "priya@example.com", subject: "Sales" }),
      tool("Read", { file_path: "/tmp/a.txt" }),
      tool("mcp__browser__browser_snapshot", {}),
    ];
    const layers = burgerLayers(run);
    expect(layers.map((layer) => [layer.kind, layer.app, layer.words, layer.status])).toEqual([
      ["app", "googlesheets", "batch get", "done"],
      ["app", "gmail", "send email", "done"],
    ]);
    expect(layers[0]!.read).toBe(true);
    expect(layers[1]!.read).toBe(false);
  });

  it("reads only the run since the person's last ask, and marks the live step running", () => {
    const old = tool("Bash", { command: "git push" }, { summary: "git push" });
    const live = tool("Bash", { command: "pnpm build" }, { summary: "pnpm build", ok: undefined });
    const layers = burgerLayers([old, ask("build it"), live], new Set([live.id]));
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ kind: "shell", words: "pnpm build", status: "running" });
  });

  it("names shell, file and browser layers", () => {
    const layers = burgerLayers([
      ask("publish"),
      tool("Bash", { command: "git push origin main" }, { summary: "git push origin main" }),
      tool("Write", { file_path: "/w/notes.md", content: "hi" }),
      tool("mcp__browser__browser_navigate", { url: "https://example.com/dash" }),
    ]);
    expect(layers.map(layerLabel)).toEqual(["Run git push origin main", "Write notes.md", "Open example.com"]);
  });
});

describe("draftWorkflow", () => {
  it("returns nothing for a run of fewer than two steps", () => {
    expect(draftWorkflow([ask("hi"), tool("Bash", { command: "git push" }, { summary: "git push" })])).toBeNull();
  });

  it("turns values from the ask into args and pipes values an earlier step returned", () => {
    const draft = draftWorkflow([
      ask("Send the latest invoice to priya@example.com"),
      multi("GMAIL_FETCH_EMAILS", { query: "invoice" }, { data: { results: [{ response: { data: { messages: [{ id: "18c0ffee99", subject: "Invoice" }] } } }] } }),
      multi("GMAIL_FORWARD_MESSAGE", { message_id: "18c0ffee99", recipient_email: "priya@example.com" }),
    ])!;
    expect(workflowSchema.safeParse(draft.workflow).success).toBe(true);
    expect(draft.workflow.summary).toBe("Send the latest invoice to priya@example.com");
    expect(draft.workflow.args).toEqual({ recipient: { default: "priya@example.com", label: "recipient email" }, query: { default: "invoice", label: "query" } });
    const forward = draft.workflow.steps[1]!;
    expect(forward).toMatchObject({ kind: "app", app: "gmail", tool: "GMAIL_FORWARD_MESSAGE" });
    expect(forward.kind === "app" && forward.args).toEqual({
      message_id: { $step: "s1", path: "data.results.0.response.data.messages.0.id" },
      recipient_email: { $arg: "recipient" },
    });
  });

  it("passes a shell arg through the environment, never into quoted text", () => {
    const draft = draftWorkflow([
      ask("deploy the staging branch"),
      tool("Bash", { command: "git push origin staging" }, { summary: "git push origin staging" }),
      tool("Bash", { command: "cp out.txt 'staging done.txt'" }, { summary: "cp out.txt 'staging done.txt'" }),
    ])!;
    const [push, note] = draft.workflow.steps;
    expect(push).toMatchObject({ kind: "shell", run: 'git push origin "$OMB_ARG_VALUE"' });
    expect(note).toMatchObject({ kind: "shell", run: "cp out.txt 'staging done.txt'" });
    expect(draft.workflow.args).toEqual({ value: { default: "staging" } });
  });

  it("writes long text the AI composed from a read with an AI step, marked non-deterministic", () => {
    const body = "Revenue rose 4% this week.\nTop region: West.\nNotes follow for the team, with every number checked against the sheet.";
    const draft = draftWorkflow([
      ask("Summarise the sales sheet and email it to the team"),
      multi("GOOGLESHEETS_BATCH_GET", { spreadsheet_id: "1AbCdEf" }, { data: { values: [["West", 40]] } }),
      multi("GMAIL_SEND_EMAIL", { recipient_email: "team@example.com", body }),
    ])!;
    const steps = draft.workflow.steps;
    expect(steps.map((step) => [step.id, step.kind])).toEqual([["s1", "app"], ["s2_write", "ai"], ["s2", "app"]]);
    expect(steps[1]).toMatchObject({ deterministic: false, input: { $step: "s1" }, example: body, label: "Write the body" });
    expect(steps[2]!.kind === "app" && steps[2]!.args.body).toEqual({ $step: "s2_write" });
  });

  it("saves a clipped, masked or code-running call as an AI step instead of guessing", () => {
    const draft = draftWorkflow([
      ask("tidy up"),
      multi("GMAIL_SEND_EMAIL", { recipient_email: "a@example.com", body: "[large content omitted]" }),
      tool("mcp__browser__browser_click", { ref: "e12" }),
      multi("COMPOSIO_REMOTE_WORKBENCH", { code: "print(1)" }),
    ])!;
    expect(draft.workflow.steps.map((step) => [step.kind, step.kind === "ai" && step.deterministic])).toEqual([["ai", false], ["ai", false], ["ai", false]]);
  });

  it("writes no secret into the saved workflow", () => {
    const key = `sk-ant-${"a".repeat(40)}`;
    const draft = draftWorkflow([
      ask(`call the api with ${key}`),
      tool("Bash", { command: `curl -X POST -H "Authorization: Bearer ${key}" https://api.example.com/run` }, { summary: "curl -X POST https://api.example.com/run" }),
      multi("SLACK_SEND_MESSAGE", { channel: "#ops", text: "ran" }),
    ])!;
    const saved = JSON.stringify(draft.workflow);
    expect(saved).not.toContain(key);
    expect(draft.workflow.steps[0]).toMatchObject({ kind: "ai", deterministic: false });
    expect(saved).not.toContain("aaaaaaaaaaaaaaaa");
  });

  it("renders a SKILL.md any bot can follow", () => {
    const draft = draftWorkflow([
      ask("Send the latest invoice to priya@example.com"),
      multi("GMAIL_FETCH_EMAILS", { query: "invoice" }),
      multi("GMAIL_SEND_EMAIL", { recipient_email: "priya@example.com" }),
    ])!;
    const name = workflowSkillName(draft.workflow.summary, new Set(["send-the-latest-invoice-to-priya"]));
    expect(name).toBe("send-the-latest-invoice-to-priya-2");
    expect(workflowSkillName("Email this week's sales sheet", new Set())).toBe("email-this-weeks-sales-sheet");
    const md = renderWorkflowSkillMd(name, draft.workflow);
    expect(md).toContain(`name: ${name}`);
    expect(md).toContain("tags: workflow");
    expect(md).toContain("2. Gmail: Send email (GMAIL_SEND_EMAIL) (recipient email: recipient, default \"priya@example.com\")");
  });
});

describe("the top bun's line", () => {
  it("asks for one line in the request's language, from the steps", () => {
    const prompt = summaryPrompt("Mail the sheet to Priya", burgerLayers([ask("x"), multi("GOOGLESHEETS_BATCH_GET", {}), multi("GMAIL_SEND_EMAIL", {})]));
    expect(prompt).toContain("Request: Mail the sheet to Priya");
    expect(prompt).toContain("1. Google Sheets: Read from Google Sheets");
    expect(prompt).toContain("2. Gmail: Send email");
  });

  it("keeps one clean line of the model's reply", () => {
    expect(cleanSummary('"Emails the sales sheet to Priya."\nMore text')).toBe("Emails the sales sheet to Priya");
    expect(cleanSummary("Summary: Archives the logs")).toBe("Archives the logs");
    expect(cleanSummary("  ")).toBeNull();
    expect(cleanSummary(undefined)).toBeNull();
    expect(cleanSummary("x".repeat(200))!.length).toBe(90);
  });
});
