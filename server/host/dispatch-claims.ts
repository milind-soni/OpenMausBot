/** The direct turns being set up or sent to their engine, by thread. A thread holding a claim reads busy. */
export type DispatchClaims<Claim extends { id: string }> = Map<string, Claim> & {
  released(threadId: string): Promise<void>;
};

export function createDispatchClaims<Claim extends { id: string }>(): DispatchClaims<Claim> {
  return new ClaimsByThread<Claim>();
}

class ClaimsByThread<Claim extends { id: string }> extends Map<string, Claim> {
  private readonly waiting = new Map<string, Array<() => void>>();

  released(threadId: string): Promise<void> {
    const claim = this.get(threadId);
    if (!claim) return Promise.resolve();
    return new Promise((resolve) => this.waiting.set(claim.id, [...(this.waiting.get(claim.id) ?? []), resolve]));
  }

  override set(threadId: string, claim: Claim): this {
    const before = this.get(threadId);
    super.set(threadId, claim);
    if (before && before.id !== claim.id) this.release(before.id);
    return this;
  }

  override delete(threadId: string): boolean {
    const before = this.get(threadId);
    const deleted = super.delete(threadId);
    if (before) this.release(before.id);
    return deleted;
  }

  override clear(): void {
    const before = [...this.values()];
    super.clear();
    for (const claim of before) this.release(claim.id);
  }

  private release(claimId: string): void {
    const waiters = this.waiting.get(claimId) ?? [];
    this.waiting.delete(claimId);
    for (const resolve of waiters) resolve();
  }
}
