import { DEEP_LINK_PREFIX } from "../electron/app-identity.mjs";

/** The Use my Mac link older bot messages hold; it shows as plain text. */
export const USE_MY_COMPUTER_URL = `${DEEP_LINK_PREFIX}use-my-computer`;

export function isUseMyComputerUrl(value: string): boolean {
  return value.trim().toLowerCase() === USE_MY_COMPUTER_URL;
}
