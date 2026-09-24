import type { AppState } from "@/state/store";

export interface PendingPermission {
  key: string;
  botId: string;
  threadId?: string;
  messageId: string;
  requestId: string;
}

export type PermissionCountdown = Record<string, { remaining?: number; cancelled?: boolean; firing?: boolean }>;

export function pendingPermissions(state: Pick<AppState, "bots" | "groups">): PendingPermission[] {
  const pending: PendingPermission[] = [];
  for (const bot of state.bots) {
    for (const message of bot.messages) {
      const card = message.card;
      if (card?.requestType === "permission" && card.requestId && !card.answered && !card.dismissed) {
        pending.push({ key: `${bot.id}:${message.id}`, botId: bot.id, messageId: message.id, requestId: card.requestId });
      }
    }
  }
  for (const group of state.groups) {
    for (const message of group.messages) {
      const card = message.card;
      if (card?.requestType === "permission" && card.requestId && message.from?.botId && !card.answered && !card.dismissed) {
        pending.push({ key: `${group.threadId}:${message.id}`, botId: message.from.botId, threadId: group.threadId, messageId: message.id, requestId: card.requestId });
      }
    }
  }
  return pending;
}

export class PermissionAutoApproveClock {
  private cards = new Map<string, { card: PendingPermission; since: number; cancelled: boolean; firing: boolean }>();
  private lastActivity: number;
  private enabled = true;
  private delayMs = 10_000;
  private lastView = "";

  constructor(
    private readonly onFire: (card: PendingPermission) => void,
    private readonly onChange: (view: PermissionCountdown) => void,
    private readonly now = () => Date.now(),
  ) {
    this.lastActivity = now();
  }

  configure(enabled: boolean, delaySeconds: number) {
    const delayMs = delaySeconds * 1_000;
    if (this.enabled !== enabled || this.delayMs !== delayMs) this.lastActivity = this.now();
    this.enabled = enabled;
    this.delayMs = delayMs;
    this.tick();
  }

  sync(cards: PendingPermission[]) {
    const keys = new Set(cards.map((card) => card.key));
    for (const key of this.cards.keys()) if (!keys.has(key)) this.cards.delete(key);
    for (const card of cards) {
      const current = this.cards.get(card.key);
      if (current) current.card = card;
      else this.cards.set(card.key, { card, since: this.now(), cancelled: false, firing: false });
    }
    this.tick();
  }

  activity() {
    this.lastActivity = this.now();
    this.tick();
  }

  cancel(key: string) {
    const card = this.cards.get(key);
    if (card) card.cancelled = true;
    this.tick();
  }

  tick() {
    const now = this.now();
    const view: PermissionCountdown = {};
    for (const [key, card] of this.cards) {
      if (card.cancelled) view[key] = { cancelled: true };
      else if (card.firing) view[key] = { firing: true };
      else if (this.enabled) {
        const remainingMs = Math.max(card.since, this.lastActivity) + this.delayMs - now;
        if (remainingMs <= 0) {
          card.firing = true;
          view[key] = { firing: true };
          this.onFire(card.card);
        } else view[key] = { remaining: Math.ceil(remainingMs / 1_000) };
      }
    }
    const serialized = JSON.stringify(view);
    if (serialized !== this.lastView) {
      this.lastView = serialized;
      this.onChange(view);
    }
  }
}
