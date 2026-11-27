/** The Use my Mac link older bot messages hold; it shows as plain text. */
export const USE_MY_COMPUTER_URL = "openmausbot://use-my-computer";

export function isUseMyComputerUrl(value: string): boolean {
  return value.trim().toLowerCase() === USE_MY_COMPUTER_URL;
}
