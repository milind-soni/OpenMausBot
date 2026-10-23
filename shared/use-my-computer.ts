/** The link a bot on My Cloud gives the person when it needs their computer: in OpenMausBot on that computer it opens
 * the app's own Use my Mac popup, which turns on every part of Let my bots use this Mac. Anywhere else it is plain text. */
export const USE_MY_COMPUTER_URL = "openmausbot://use-my-computer";

export function isUseMyComputerUrl(value: string): boolean {
  return value.trim().toLowerCase() === USE_MY_COMPUTER_URL;
}

/** The popup's button, by the word the person knows the computer by. */
export function useMyComputerLabel(device: "Mac" | "PC" | "computer"): string {
  return device === "computer" ? "Use this computer" : `Use my ${device}`;
}

/** The link, as a bot writes it. */
export function useMyComputerLink(device: "Mac" | "PC" | "computer"): string {
  return `[${useMyComputerLabel(device)}](${USE_MY_COMPUTER_URL})`;
}
