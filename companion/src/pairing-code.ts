import { randomInt } from "node:crypto";

export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;

/** `randomInt`, not `Math.random`: the code is a credential. */
export function generatePairingCode(): string {
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) code += PAIRING_CODE_ALPHABET[randomInt(0, PAIRING_CODE_ALPHABET.length)];
  return code;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "I");
}

export function formatPairingCode(code: string): string {
  return normalizePairingCode(code).match(/.{1,4}/g)?.join("-") ?? code;
}

/** Six digits: what a phone app from before the 12-character code sends. */
export function isOldPairingCode(input: string): boolean {
  return /^\d{6}$/.test(input.replace(/[\s-]/g, ""));
}
