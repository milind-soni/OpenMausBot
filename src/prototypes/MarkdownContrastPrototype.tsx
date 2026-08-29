import { ChatMarkdown } from "@/components/ChatMarkdown";

const SAMPLE = `The correct Centipede architecture is:

\`\`\`text
Chief understands the outcome
        ↓
WorkLock identifies the obligation
\`\`\``;

/** Dev-only regression fixture for chat markdown foreground/background contrast. */
export function MarkdownContrastPrototype() {
  return (
    <main className="min-h-screen bg-app p-8 text-ink">
      <div className="mx-auto max-w-[680px] rounded-[24px] bg-raised px-5 py-4 shadow-sm">
        <ChatMarkdown text={SAMPLE} />
      </div>
    </main>
  );
}
