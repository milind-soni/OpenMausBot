import type { HandoffView } from "../coordinator.ts";
import type { OriginKind } from "../runtime/types.ts";

/** Runtime lineage retains routine grants without turning a routine into user-authored evidence. */
export function delegationOriginKind(node: Pick<HandoffView, "originKind" | "origin"> | undefined): OriginKind {
  return node?.originKind ?? (node?.origin?.kind === "user" ? "person" : "outside");
}
