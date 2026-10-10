// OpenMausBot policy layered over Playwright's vendored ARIA snapshot.
// Keep this pure so the exact field classification can be regression-tested
// without a browser DOM.
const SENSITIVE_FIELD =
  /(password|passwd|passcode|client.?secret|api.?key|secret.?key|private.?key|signing.?key|webhook.?secret|secret.?access.?key|access.?token|auth.?token|refresh.?token|bearer.?token|one.?time|otp|verification.?code|recovery.?code|seed.?phrase|mnemonic|recovery.?phrase|security.?answer|cc-.+|card.?(number|security|cvv|cvc)|cvv|cvc|bank.?(account|routing)|routing.?(number|code)|account.?(number|no)|social.?(security|insurance)|ssn|tax.?id)/i;

export function isSensitiveInput(type: string, hints: Array<string | null | undefined>): boolean {
  if (type.toLowerCase() === "password") return true;
  const raw = hints.filter(Boolean).join(" ");
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  return SENSITIVE_FIELD.test(raw) || /(?:^| )(pin|security code)(?: |$)/.test(words);
}

/** Collect the browser-visible names sites use for credential fields. A
 * plain `name=credential` is not descriptive, but its accessible label or
 * placeholder often is. Keeping this next to the classifier ensures raw
 * host snapshots and action gating make the same decision. */
export function isSensitiveElement(element: Element, accessibleName?: string | null): boolean {
  const tag = element.tagName.toLowerCase();
  const role = (element.getAttribute("role") ?? "").toLowerCase();
  const editable = tag === "input"
    || tag === "textarea"
    || (element instanceof HTMLElement && element.isContentEditable)
    || ["textbox", "searchbox", "combobox"].includes(role);
  if (!editable) return false;
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const labels = "labels" in input && input.labels
    ? [...input.labels].map(label => label.textContent)
    : [];
  const wrappingLabel = element.closest("label")?.textContent;
  const externalLabels = element.id
    ? [...element.ownerDocument.querySelectorAll("label[for]")]
        .filter(label => label.getAttribute("for") === element.id)
        .map(label => label.textContent)
    : [];
  const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map(id => element.ownerDocument.getElementById(id)?.textContent);
  return isSensitiveInput(tag === "input" ? (input as HTMLInputElement).type : tag, [
    accessibleName,
    element.getAttribute("name"),
    element.id,
    element.getAttribute("aria-label"),
    element.getAttribute("autocomplete"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    ...labels,
    wrappingLabel,
    ...externalLabels,
    ...labelledBy,
  ]);
}
