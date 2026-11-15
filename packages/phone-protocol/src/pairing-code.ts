/** The one kind of secret a device joins with: 12 symbols from this alphabet, shown as `7KQ2-M9XD-H4TP`. Dashes,
 * spaces and case never matter. A link or QR carries the same code with an address. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;
/** The high-entropy credential a QR carries instead of the code; accepted wherever a code is, never shown. */
export const PAIRING_CREDENTIAL_PREFIX = "omb_pair_";
const PAIRING_CREDENTIAL = /^omb_pair_[A-Za-z0-9_-]{43}$/;

export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
}

export function formatPairingCode(code: string): string {
  return normalizePairingCode(code).match(/.{1,4}/g)?.join("-") ?? code;
}

/** What someone typed or pasted where a pairing code goes, and the sentence that explains anything else. */
export type PairingInput =
  | { kind: "code"; code: string }
  | { kind: "credential"; credential: string }
  | { kind: "wrong"; problem: PairingInputProblem }
  | { kind: "empty" };

export type PairingInputProblem = "emailCode" | "oldCode" | "scriptKey" | "notACode";

/** English for each problem; src/locales/en.json carries the same sentences under the same keys. */
export const PAIRING_INPUT_PROBLEM_TEXT = {
  "serverError.pair.emailCode": "That's a sign-in code from an email. Pairing needs a 12-character code like 7KQ2-M9XD-H4TP.",
  "serverError.pair.oldCode": "That's a code from an older MausBot. Make a new one on the other computer: Phone & devices → Pair a device.",
  "serverError.pair.scriptKey": "That's a script key. Pairing needs a pairing code.",
  "serverError.pair.notACode": "That isn't a pairing code. Pairing needs a 12-character code like 7KQ2-M9XD-H4TP.",
} as const;

/** `serverError.*` catalog keys, so the server, the CLI and every screen word a wrong kind of code the same way. */
export const PAIRING_INPUT_PROBLEM_KEY: Record<PairingInputProblem, keyof typeof PAIRING_INPUT_PROBLEM_TEXT> = {
  emailCode: "serverError.pair.emailCode",
  oldCode: "serverError.pair.oldCode",
  scriptKey: "serverError.pair.scriptKey",
  notACode: "serverError.pair.notACode",
};

/** The `code` on every refused pairing: `POST /api/pair` on a computer, a server or a Cloud, and `POST /api/auth/pair`.
 * `error` stays plain words any client can show; a client branches on `code`, never on `error`. */
export type PairingErrorCode =
  /** Not JSON, or not the fields a pairing sends. */
  | "pairing_bad_request"
  /** No open pairing has this code or credential. */
  | "pairing_code_wrong"
  /** A computer has no pairing open. */
  | "pairing_not_open"
  /** Too many wrong codes: wait (a server or Cloud says until when), or start pairing again (a computer). */
  | "pairing_too_many"
  /** A browser sign-in link that has expired or was used. */
  | "pairing_link_expired"
  | "pairing_email_code"
  | "pairing_old_code"
  | "pairing_script_key"
  /** Through the encrypted relay only the QR code's credential pairs, never a typed code. */
  | "pairing_qr_only"
  /** A computer already has as many paired devices as it allows. */
  | "pairing_device_limit"
  /** A personal Cloud pairs only its owner's devices. */
  | "cloud_personal"
  | "pairing_failed";

export const PAIRING_INPUT_PROBLEM_CODE: Record<Exclude<PairingInputProblem, "notACode">, PairingErrorCode> = {
  emailCode: "pairing_email_code",
  oldCode: "pairing_old_code",
  scriptKey: "pairing_script_key",
};

function fromLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  return url.searchParams.get("token") ?? url.searchParams.get("code") ?? hash.get("code");
}

/** Reads a typed code, an `omb_pair_` credential, or a link that carries either (`openmausbot://pair?…`,
 * `…/pair#code=…`, `?code=…`). */
export function readPairingInput(raw: string): PairingInput {
  let value = raw.trim();
  if (!value) return { kind: "empty" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const carried = fromLink(value);
    if (!carried) return { kind: "wrong", problem: "notACode" };
    value = carried.trim();
  }
  if (value.startsWith("omb_sess_")) return { kind: "wrong", problem: "scriptKey" };
  if (value.startsWith(PAIRING_CREDENTIAL_PREFIX)) {
    return PAIRING_CREDENTIAL.test(value) ? { kind: "credential", credential: value } : { kind: "wrong", problem: "notACode" };
  }
  const digits = value.replace(/[\s-]/g, "");
  if (/^\d{8}$/.test(digits)) return { kind: "wrong", problem: "emailCode" };
  if (/^\d{6}$/.test(digits)) return { kind: "wrong", problem: "oldCode" };
  const code = normalizePairingCode(value);
  if (code.length !== PAIRING_CODE_LENGTH || [...code].some((symbol) => !PAIRING_CODE_ALPHABET.includes(symbol))) {
    return { kind: "wrong", problem: "notACode" };
  }
  return { kind: "code", code };
}
