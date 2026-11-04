// The Gmail drafts one request has reserved, shared by the turn that asked and the handoffs it started. Each turn's generation
// and each coordination node keeps the set it got first, so a child reserves against its parent's drafts.
type DraftOwner = { generation: string; generations: { has(id: string): boolean }; gmailDrafts?: Set<string> };

export function createGmailDrafts(deps: {
  node(id: string): { threadId: string; parentId?: string | null; status: string } | null | undefined;
  ended(status: string): boolean;
  owner(threadId: string): DraftOwner | undefined;
}) {
  const byGeneration = new Map<string, Set<string>>();
  const byNode = new Map<string, Set<string>>();

  function forNode(id: string): Set<string> | undefined {
    for (const cachedId of byNode.keys()) {
      const node = deps.node(cachedId);
      if (!node || deps.ended(node.status)) byNode.delete(cachedId);
    }
    const node = deps.node(id);
    if (!node) return undefined;
    const cached = byNode.get(id);
    if (cached) return cached;
    const owner = deps.owner(node.threadId);
    const reserved = owner?.generations.has(id) && owner.gmailDrafts ? owner.gmailDrafts :
      (node.parentId ? forNode(node.parentId) : undefined) ?? new Set<string>();
    byNode.set(id, reserved);
    return reserved;
  }

  return {
    forNode,
    forTurn(threadId: string, generation: string, handoffId?: string): Set<string> {
      const cached = byGeneration.get(generation);
      if (cached) return cached;
      const owner = deps.owner(threadId);
      const reserved = owner?.generation === generation && owner.gmailDrafts ? owner.gmailDrafts :
        forNode(handoffId ?? generation) ?? new Set<string>();
      byGeneration.set(generation, reserved);
      return reserved;
    },
    forRoomTurn(generation: string, handoffId: string): void {
      byGeneration.set(generation, forNode(handoffId) ?? new Set<string>());
    },
    endTurn(generation: string): void {
      byGeneration.delete(generation);
    },
  };
}
