// Web-side mirror of server/bot-overview.ts's response shape for
// GET /api/bots/:id/overview. No logic lives here — the sentences are
// built once, server-side, so the phones and this dialog can never
// disagree about what a bot does.
export interface BotOverview {
  who: { name: string; title: string; blurb: string; soulLead: string };
  does: string[];
  reaches: string[];
  wont: string[];
  recent: Array<{ at: number; summary: string }>;
}
