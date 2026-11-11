import type { CompanionAccountState } from "../types/ogb";
import type { CompanionState, PhoneDevice } from "./companion-types";

export const olderAppPhones = (state: Pick<CompanionState, "devices"> | null | undefined): PhoneDevice[] =>
  (state?.devices ?? []).filter((device) => !device.e2eAt);

/** The secure address was ended for old phone apps and a phone here still depends on it. */
export function showTunnelRetiredNotice(
  account: Pick<CompanionAccountState, "tunnelRetired"> | null,
  state: Pick<CompanionState, "devices"> | null,
): boolean {
  return account?.tunnelRetired === true && olderAppPhones(state).length > 0;
}
