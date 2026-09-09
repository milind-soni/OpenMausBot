import { afterEach, describe, expect, it, vi } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";

import { visibleMessages, type Bot, type Message } from "@/state/store";
import { composeMessage, fileAttachment } from "./composer-attachments";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  formatExportDate,
  formatMessageTime,
  formatTranscriptMarkdown,
  slugifyTranscriptFilename,
} from "./export-transcript";

describe("export-transcript", () => {
  const fixedDate = new Date("2026-09-08T12:00:00Z");
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("formats an empty conversation cleanly", () => {
    const markdown = formatTranscriptMarkdown({
      title: "Coder",
      messages: [],
      exportedAt: fixedDate,
    });

    expect(markdown).toContain("# Thread with Coder");
    expect(markdown).toContain("No messages in this conversation yet.");
  });

  it("formats 1:1 conversation with user and bot turns", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "user",
        kind: "text",
        text: "Hello, can you help me refactor this code?",
        at: new Date("2026-09-08T12:01:00Z").getTime(),
      },
      {
        id: "m2",
        role: "bot",
        kind: "text",
        text: "Of course! Here is the refactored version:\n\n```ts\nconst x = 1;\n```",
        at: new Date("2026-09-08T12:02:00Z").getTime(),
      },
    ];

    const markdown = formatTranscriptMarkdown({
      title: "Coder",
      messages,
      botName: "Coder",
      exportedAt: fixedDate,
    });

    expect(markdown).toContain("# Thread with Coder");
    expect(markdown).toContain("### **User**");
    expect(markdown).toContain("Hello, can you help me refactor this code?");
    expect(markdown).toContain("### **Coder**");
    expect(markdown).toContain("Of course! Here is the refactored version:");
    expect(markdown).toContain("const x = 1;");
  });

  it("formats group channel conversation with multiple distinct bot senders", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "user",
        kind: "text",
        text: "Team, what is the status?",
        at: new Date("2026-09-08T12:01:00Z").getTime(),
      },
      {
        id: "m2",
        role: "bot",
        kind: "text",
        text: "Research is complete.",
        from: { botId: "b1", name: "Researcher", color: "blue" },
        at: new Date("2026-09-08T12:02:00Z").getTime(),
      },
      {
        id: "m3",
        role: "bot",
        kind: "text",
        text: "Implementation is in progress.",
        from: { botId: "b2", name: "Builder", color: "orange" },
        at: new Date("2026-09-08T12:03:00Z").getTime(),
      },
    ];

    const markdown = formatTranscriptMarkdown({
      title: "Project Alpha",
      messages,
      isGroup: true,
      exportedAt: fixedDate,
    });

    expect(markdown).toContain("# Group: Project Alpha");
    expect(markdown).toContain("### **User**");
    expect(markdown).toContain("### **Researcher**");
    expect(markdown).toContain("Research is complete.");
    expect(markdown).toContain("### **Builder**");
    expect(markdown).toContain("Implementation is in progress.");
  });

  it("formats option cards and tool activities cleanly", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "bot",
        kind: "activity",
        tool: { name: "readFile", spoken: "reading package.json", ok: true },
        at: new Date("2026-09-08T12:01:00Z").getTime(),
      },
      {
        id: "m2",
        role: "bot",
        kind: "options",
        card: {
          title: "Select framework",
          subtitle: "Which framework do you prefer?",
          options: ["React", "Vue", "Svelte"],
          answered: "React",
        },
        at: new Date("2026-09-08T12:02:00Z").getTime(),
      },
      {
        id: "m3",
        role: "user",
        kind: "text",
        text: "I selected React.",
        attachments: [{ kind: "image", path: "/tmp/screenshot.png", mime: "image/png" }],
        at: new Date("2026-09-08T12:03:00Z").getTime(),
      },
    ];

    const markdown = formatTranscriptMarkdown({
      title: "Assistant",
      messages,
      botName: "Assistant",
      exportedAt: fixedDate,
    });

    expect(markdown).toContain("🔧 _Used tool:_ `reading package.json`");
    expect(markdown).toContain("📋 **Select framework**");
    expect(markdown).toContain("Options: `React`, `Vue`, `Svelte`");
    expect(markdown).toContain("Selected: **React**");
    expect(markdown).toContain("📎 _Attachment:_ `/tmp/screenshot.png`");
  });

  it("slugifies filenames accurately", () => {
    const date = new Date(2026, 8, 8); // Sep 8, 2026
    expect(slugifyTranscriptFilename("Coder Bot", date)).toBe(
      "coder-bot-transcript-2026-09-08.md",
    );
    expect(slugifyTranscriptFilename("  Project #1 (Alpha)!  ", date)).toBe(
      "project-1-alpha-transcript-2026-09-08.md",
    );
    expect(slugifyTranscriptFilename("   ", date)).toBe(
      "conversation-transcript-2026-09-08.md",
    );
  });

  it("preserves Markdown whitespace and handles real user attachments without private paths", () => {
    const stored = composeMessage("Review this", [
      fileAttachment("Original notes.pdf", "/private/attachments/123e4567-e89b-42d3-a456-426614174000.pdf", 42),
      { kind: "image", id: "image", path: "/private/attachments/123e4567-e89b-42d3-a456-426614174000.png", name: "Screenshot.png", mime: "image/png", size: 42 },
    ]);
    const text = "    indented code\n\nhard break  \n";
    const markdown = formatTranscriptMarkdown({
      title: "Assistant", exportedAt: fixedDate,
      messages: [
        { id: "1", role: "bot", kind: "text", text, at: 1 },
        { id: "2", role: "user", kind: "text", text: stored.replace("Review this", text), at: 2 },
      ],
    });
    expect(markdown.split(text)).toHaveLength(3);
    expect(markdown).toContain("Original notes.pdf");
    expect(markdown).toContain("Screenshot.png");
    expect(markdown).not.toContain("attached-file");
    expect(markdown).not.toContain("attached-image");
    expect(markdown).not.toContain("/private/attachments");
  });

  it("marks screen captures without embedding pixels or exporting private card fields", () => {
    const markdown = formatTranscriptMarkdown({
      title: "Assistant", exportedAt: fixedDate,
      messages: [
        { id: "screen", role: "bot", kind: "screen", png: "PRIVATE_BASE64_PIXELS", mime: "image/png", at: 1 },
        { id: "secret", role: "bot", kind: "secret", secret: { requestKey: "PRIVATE_REQUEST_KEY" } as Message["secret"], at: 2 },
      ],
    });
    expect(markdown).toContain("Screen capture");
    expect(markdown).not.toContain("PRIVATE_");
  });

  it("keeps untrusted metadata literal instead of creating links or remote images", () => {
    const hostile = "` ![tracker](https://tracker.invalid/pixel)\n<img src='https://tracker.invalid/pixel'>";
    const markdown = formatTranscriptMarkdown({
      title: hostile, exportedAt: fixedDate,
      messages: [
        { id: "1", role: "bot", kind: "activity", from: { botId: "b", name: hostile, color: "blue" }, tool: { name: hostile }, at: 1 },
        { id: "2", role: "bot", kind: "text", attachments: [{ kind: "image", path: hostile, mime: "image/png" }], at: 2 },
        { id: "3", role: "bot", kind: "options", card: { title: hostile, subtitle: hostile, options: [hostile], answered: hostile }, at: 3 },
      ],
    });
    const ast = JSON.stringify(fromMarkdown(markdown));
    expect(ast).not.toMatch(/"type":"(?:image|link|html)"/);
    expect(fromMarkdown(markdown).children.filter((node) => node.type === "heading")).toHaveLength(4);
  });

  it("keeps attachment-like examples intact and excludes tool activity on request", () => {
    const text = '```xml\n<attached-image path="/example.png" />\n```';
    const markdown = formatTranscriptMarkdown({
      title: "Assistant", includeTools: false, exportedAt: fixedDate,
      messages: [
        { id: "1", role: "user", kind: "text", text, at: 2 },
        { id: "2", role: "bot", kind: "activity", tool: { name: "PRIVATE_TOOL" }, at: 1 },
      ],
    });
    expect(markdown).toContain(text);
    expect(markdown).not.toContain("PRIVATE_TOOL");
  });

  it("exports only the active branch in transcript order, not timestamp order", () => {
    const bot = {
      activeLeafId: "reply",
      messages: [
        { id: "old", role: "user", kind: "text", text: "discarded branch", parentId: null, at: 1 },
        { id: "current", role: "user", kind: "text", text: "active question", parentId: null, at: 3 },
        { id: "reply", role: "bot", kind: "text", text: "active response", parentId: "current", at: 2 },
      ],
    } as Bot;
    const markdown = formatTranscriptMarkdown({ title: "Assistant", messages: visibleMessages(bot), exportedAt: fixedDate });
    expect(markdown).not.toContain("discarded branch");
    expect(markdown.indexOf("active question")).toBeLessThan(markdown.indexOf("active response"));
  });

  it("bounds a filename and cannot produce a path", () => {
    const filename = slugifyTranscriptFilename("../" + "A".repeat(1_000));
    expect(filename.length).toBeLessThan(200);
    expect(filename).not.toMatch(/[\\/]/);
  });

  it("reports clipboard success, absence, and denied permission without requests", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyTranscriptToClipboard("transcript")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("transcript");
    writeText.mockRejectedValueOnce(new Error("denied"));
    expect(await copyTranscriptToClipboard("transcript")).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await copyTranscriptToClipboard("transcript")).toBe(false);
  });

  it("downloads a local Markdown blob and revokes its URL", async () => {
    vi.useFakeTimers();
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
    vi.stubGlobal("window", { setTimeout });
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-transcript");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    downloadMarkdownTranscript("transcript.md", "# Private transcript");
    expect(link).toMatchObject({ href: "blob:local-transcript", download: "transcript.md" });
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    expect(await blob.text()).toBe("# Private transcript");
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:local-transcript");
  });

  it("formats dates and times consistently", () => {
    const formattedDate = formatExportDate(fixedDate);
    expect(typeof formattedDate).toBe("string");
    expect(formattedDate.length).toBeGreaterThan(0);

    const formattedTime = formatMessageTime(fixedDate.getTime());
    expect(typeof formattedTime).toBe("string");
    expect(formattedTime.length).toBeGreaterThan(0);
  });
});
