const SENSITIVE_FIELD =
  /(password|passwd|passcode|client.?secret|api.?key|secret.?key|private.?key|signing.?key|webhook.?secret|secret.?access.?key|access.?token|auth.?token|refresh.?token|bearer.?token|one.?time|otp|verification.?code|recovery.?code|seed.?phrase|mnemonic|recovery.?phrase|security.?answer|cc-.+|card.?(number|security|cvv|cvc)|cvv|cvc|bank.?(account|routing)|routing.?(number|code)|account.?(number|no)|social.?(security|insurance)|ssn|tax.?id)/i;

/** Fields whose value a snapshot never shows: passwords, codes, card and account numbers, named by type, autocomplete, name, id, placeholder or label. */
export function isSensitiveInput(type: string, hints: ReadonlyArray<string | null | undefined>): boolean {
  if (type.toLowerCase() === "password") return true;
  const raw = hints.filter(Boolean).join(" ");
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  return SENSITIVE_FIELD.test(raw) || /(?:^| )(pin|security code)(?: |$)/.test(words);
}
