// A profile proposal card with the cosmetic fields, for before/after
// evidence: the same fixture renders on main (card copy only) and on this
// branch (the proposed avatar image appears under the copy). The image is
// served by the capture script at /__avatar-fixture.png. Driven headlessly
// through mountPreview in preview-fixture.ts.
import { createRoot } from "react-dom/client";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { applySkin, readSkin } from "../../src/lib/skins";
import type { Bot, Message } from "../../src/state/store";
import "../../src/styles.css";

const avatarUrl = "/__avatar-fixture.png";
const message = (subtitle: string, changes: Record<string, unknown>, before: Record<string, unknown>): Message => ({
  id: "profile-card",
  role: "bot",
  kind: "options",
  at: 1,
  card: {
    title: "Update Scout's profile?",
    subtitle,
    options: ["Confirm", "Cancel"],
    requestId: "req-preview",
    tool: "update_profile",
    profileRequest: {
      version: 1, requestId: "req-preview", botId: "bot-1", threadId: "thread-1",
      targetBotId: "bot-1", targetName: "Scout", createdAt: 1, reason: "you asked",
      changes, before, expectedRevision: "r",
    },
  },
});

const cards: Message[] = [
  message(
    "Why: you asked\nName: \"Scout\" → \"Kiwi\"\nNothing runs.",
    { name: "Kiwi" },
    { name: "Scout" },
  ),
  message(
    "Why: you asked\nColor: blue → teal\nAvatar: set to the proposed image\nNothing runs.",
    { color: "teal", avatarUrl },
    { color: "blue", avatarUrl: "" },
  ),
];
const bot = { id: "bot-1", name: "Scout" } as unknown as Bot;

function Fixture() {
  return <div className="flex h-screen items-center justify-center gap-6 bg-app p-8">
    {cards.map((card) => <div key={card.id + card.card!.title} className="w-96 rounded-lg border border-hairline/50 bg-card p-3">
      <ApprovalCard bot={bot} message={card} />
    </div>)}
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<Fixture />);
