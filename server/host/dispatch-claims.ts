/** The direct turns being set up or sent to their engine, by thread. A thread holding a claim reads busy. */
export type DispatchClaims<Claim extends { id: string }> = Map<string, Claim> & {
  released(threadId: string): Promise<void>;
};

export function createDispatchClaims<Claim extends { id: string }>(): DispatchClaims<Claim> {
  return new ClaimsByThread<Claim>();
}

class ClaimsByThread<Claim extends { id: string }> extends Map<string, Claim> {
  private readonly waiting = new Map<string, { claimId: string; resolvers: Array<() => void> }>();

  released(threadId: string): Promise<void> {
    const claim = this.get(threadId);
    if (!claim) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.waiting.get(threadId);
      if (waiters?.claimId === claim.id) waiters.resolvers.push(resolve);
      else this.waiting.set(threadId, { claimId: claim.id, resolvers: [resolve] });
    });
  }

  override set(threadId: string, claim: Claim): this {
    super.set(threadId, claim);
    if (this.waiting.get(threadId)?.claimId !== claim.id) this.release(threadId);
    return this;
  }

  override delete(threadId: string): boolean {
    const deleted = super.delete(threadId);
    this.release(threadId);
    return deleted;
  }

  override clear(): void {
    const threads = [...this.waiting.keys()];
    super.clear();
    for (const threadId of threads) this.release(threadId);
  }

  private release(threadId: string): void {
    const waiters = this.waiting.get(threadId);
    this.waiting.delete(threadId);
    for (const resolve of waiters?.resolvers ?? []) resolve();
  }
}
