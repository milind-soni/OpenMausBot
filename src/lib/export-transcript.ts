import type { Message } from "@/state/store";
import { splitTranscriptAttachments } from "./composer-attachments";
import { copyText } from "./copy-text";

export interface ExportTranscriptOptions {
  title: string;
  messages: readonly Message[];
  botName?: string;
  isGroup?: boolean;
  exportedAt?: Date;
  includeTools?: boolean;
}

export function formatExportDate(date: Date): string {
  try {
    return date.toLocaleString("en-US", {
      dateStyle: "long",
      timeStyle: "short",
    });
  } catch {
    return date.toISOString();
  }
}

export function formatMessageTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function markdownLabel(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
}

function inlineCode(value: string): string {
  let delimiter = "`";
  for (const match of value.matchAll(/`+/g)) {
    if (match[0].length >= delimiter.length) delimiter = "`".repeat(match[0].length + 1);
  }
  const text = value.replace(/[\r\n]+/g, " ");
  const padding = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${delimiter}${padding}${text}${padding}${delimiter}`;
}

export function formatTranscriptMarkdown(options: ExportTranscriptOptions): string {
  const {
    title,
    messages,
    botName,
    isGroup = false,
    exportedAt = new Date(),
    includeTools = true,
  } = options;

  const headerTitle = isGroup ? `# Group: ${markdownLabel(title)}` : `# Thread with ${markdownLabel(title)}`;
  const lines: string[] = [
    headerTitle,
    `_Exported on ${formatExportDate(exportedAt)}_`,
    "",
    "---",
  ];

  if (!messages || messages.length === 0) {
    lines.push("", "_No messages in this conversation yet._");
    return lines.join("\n");
  }

  for (const message of messages) {
    const isUser = message.role === "user";
    const author = isUser ? "User" : message.from?.name || botName || "Assistant";
    const time = formatMessageTime(message.at);

    const messageLines: string[] = [];

    const userContent = isUser ? splitTranscriptAttachments(message.text ?? "", false, false) : null;
    const text = userContent?.display ?? message.text;
    if (text?.trim()) {
      messageLines.push(text);
    }

    // Export display names, never private storage paths or actionable image URLs.
    for (const attachment of [...(userContent?.images ?? []), ...(userContent?.files ?? [])]) {
      messageLines.push(`📎 _Attachment:_ ${inlineCode(attachment.name)}`);
    }
    if (message.attachments && message.attachments.length > 0) {
      for (const att of message.attachments) {
        messageLines.push(`📎 _Attachment:_ ${inlineCode(att.kind === "file" ? att.name : att.path)}`);
      }
    }

    if (message.card) {
      const cardLines = [`> 📋 **${markdownLabel(message.card.title)}**`];
      if (message.card.subtitle) {
        cardLines.push(`> ${markdownLabel(message.card.subtitle)}`);
      }
      if (message.card.options && message.card.options.length > 0) {
        cardLines.push(
          `> Options: ${message.card.options.map(inlineCode).join(", ")}`,
        );
      }
      if (message.card.answered) {
        cardLines.push(`> Selected: **${markdownLabel(message.card.answered)}**`);
      }
      messageLines.push(cardLines.join("\n"));
    }

    if (includeTools && message.kind === "activity" && message.tool) {
      const toolLabel = message.tool.spoken || message.tool.name;
      const statusIcon = message.tool.ok === false ? "❌" : "🔧";
      messageLines.push(`> ${statusIcon} _Used tool:_ ${inlineCode(toolLabel)}`);
    }

    if (message.kind === "screen" && (message.hasImage || message.png)) {
      messageLines.push("📷 _Screen capture (image not included in Markdown export)._");
    }

    if (messageLines.length > 0) {
      lines.push("");
      lines.push(`### **${markdownLabel(author)}** _(${time})_`);
      lines.push("");
      lines.push(messageLines.join("\n\n"));
      lines.push("");
      lines.push("---");
    }
  }

  return lines.join("\n");
}

export function slugifyTranscriptFilename(title: string, date = new Date()): string {
  const base =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 120)
      .replace(/^-|-$/g, "") || "conversation";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${base}-transcript-${year}-${month}-${day}.md`;
}

export function downloadMarkdownTranscript(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function copyTranscriptToClipboard(content: string): Promise<boolean> {
  return (await copyText(content)) === "copied";
}
