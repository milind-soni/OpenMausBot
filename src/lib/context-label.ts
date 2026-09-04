// Two labels every engine surface shows side by side, on purpose kept
// separate: WHO OWNS THE CONTEXT is not the same question as HOW IT IS PAID
// FOR, and conflating them is how a user comes to believe the preview
// engine reuses their Claude subscription. It does not.
import type { InstanceInfo } from "@/state/store";

export type ContextOwnership = NonNullable<NonNullable<InstanceInfo["capabilities"]>["contextOwnership"]>;

/** "Vendor session" — the installed CLI keeps the live session; "OpenMaus
 * replay" — OpenMausBot sends bounded history each turn; "OpenMaus managed"
 * — OpenMausBot runs the whole loop. */
export function contextLabel(ownership: ContextOwnership | undefined): string | undefined {
  switch (ownership) {
    case "vendor-session":
      return "Vendor session";
    case "omb-replay":
      return "OpenMaus replay";
    case "omb-loop":
      return "OpenMaus managed";
    default:
      return undefined;
  }
}

/** Authentication and billing in one short phrase. A subscription engine
 * signs in through its own CLI; a metered one uses an API key and the
 * provider bills for usage. */
export function authLabel(instance: Pick<InstanceInfo, "access" | "snapshot">): string {
  if (instance.snapshot.billing === "metered" || instance.access === "custom") return "API key · billed by the provider";
  return "Subscription sign-in";
}

/** The sentence the preview engine must always carry. Written once, here,
 * so the settings toggle, the engine row, and the setup card cannot drift
 * into three different promises. */
export const OWNED_RUNTIME_DISCLOSURE =
  "Runs the model and tool loop inside OpenMausBot against an OpenAI-compatible endpoint using your own API key, or a local server that needs none. It does not use a Claude or Codex login, and usage is billed by that provider.";
