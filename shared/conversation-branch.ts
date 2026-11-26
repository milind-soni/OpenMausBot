type BranchMessage = { id: string; parentId?: string | null; at: number };

export function branchLeafFrom(messages: readonly BranchMessage[], messageId: string): string {
  const newestChild = new Map<string, BranchMessage>();
  for (const message of messages) {
    if (typeof message.parentId !== "string") continue;
    const previous = newestChild.get(message.parentId);
    if (!previous || message.at >= previous.at) newestChild.set(message.parentId, message);
  }
  let leaf = messageId;
  for (let child = newestChild.get(leaf); child; child = newestChild.get(leaf)) leaf = child.id;
  return leaf;
}
