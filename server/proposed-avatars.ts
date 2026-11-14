// Avatars a bot proposes through propose_profile, propose_team_setup or create_bot. A stored attachment URL or ""
// (clear) passes through for the request's own checks; any other text is a picture file in the bot's own folders, copied
// into the attachment store. The caller checks the target's authority before anything is copied, and a copy whose
// request is then refused is removed again, so a refused proposal leaves nothing in the store.

const STORED = "/api/attachments/";
/** The team-setup plan's own operation cap; a longer plan is refused by its schema before any file is read. */
const MAX_OPERATIONS = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export class ProposedAvatars {
  private readonly saved: string[] = [];
  private readonly save: (path: string) => Promise<string>;
  private readonly remove: (url: string) => void;

  /** `save` copies one picture file and returns its stored URL; `remove` deletes a stored URL this request copied. */
  constructor(save: (path: string) => Promise<string>, remove: (url: string) => void) {
    this.save = save;
    this.remove = remove;
  }

  async resolve(value: unknown): Promise<unknown> {
    if (typeof value !== "string" || value.trim() === "" || value.startsWith(STORED)) return value;
    try {
      const url = await this.save(value);
      this.saved.push(url);
      return url;
    } catch (error) {
      // A later file of the same plan failing leaves none of the earlier copies behind.
      this.discard();
      throw error;
    }
  }

  /** propose_profile changes. */
  async inChanges(changes: unknown): Promise<unknown> {
    return isRecord(changes) && "avatarUrl" in changes ? { ...changes, avatarUrl: await this.resolve(changes.avatarUrl) } : changes;
  }

  /** propose_team_setup plan: each operation's fields.avatarUrl. */
  async inPlan(plan: unknown): Promise<unknown> {
    const operations = isRecord(plan) ? plan.operations : undefined;
    if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) return plan;
    const resolved = [];
    for (const operation of operations) {
      const fields = isRecord(operation) ? operation.fields : undefined;
      resolved.push(isRecord(fields) && "avatarUrl" in fields ? { ...operation, fields: await this.inChanges(fields) } : operation);
    }
    return { ...(plan as object), operations: resolved };
  }

  /** Runs the request; a refusal (thrown, or a state other than applied or pending) removes every picture copied for it. */
  async submit<T>(run: () => T | Promise<T>): Promise<T> {
    let kept = false;
    try {
      const result = await run();
      const state = isRecord(result) ? result.state : undefined;
      kept = state === undefined || state === "applied" || state === "pending";
      return result;
    } finally {
      if (!kept) this.discard();
    }
  }

  discard(): void {
    for (const url of this.saved.splice(0)) this.remove(url);
  }
}

/** Stored pictures that open profile and team-setup cards still show and would apply on confirm; a Settings clear
 * keeps them so a card waiting for the person does not lose its picture. */
export function pendingCardAvatarUrls(cards: ReadonlyArray<string | null>): string[] {
  const urls: string[] = [];
  for (const raw of cards) {
    if (!raw || !raw.includes(STORED)) continue;
    let card: unknown;
    try { card = JSON.parse(raw); } catch { continue; }
    if (!isRecord(card)) continue;
    const profile = isRecord(card.profileRequest) && isRecord(card.profileRequest.changes) ? card.profileRequest.changes.avatarUrl : undefined;
    if (typeof profile === "string") urls.push(profile);
    const operations = isRecord(card.teamSetupRequest) && Array.isArray(card.teamSetupRequest.operations) ? card.teamSetupRequest.operations : [];
    for (const operation of operations) {
      const url = isRecord(operation) && isRecord(operation.fields) ? operation.fields.avatarUrl : undefined;
      if (typeof url === "string") urls.push(url);
    }
  }
  return urls.filter((url) => url.startsWith(STORED));
}
