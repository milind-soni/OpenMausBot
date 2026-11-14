export function buttonStyle(raw: Record<string, unknown>): string {
  if (raw.color === "danger" || raw.style === "danger") return "danger";
  if (raw.variant === "ghost" || raw.style === "quiet") return "quiet";
  if (raw.style === "secondary" || raw.variant === "outline" || raw.variant === "soft" || raw.color === "secondary") return "secondary";
  return raw.style === "primary" || raw.color === "primary" || raw.variant === "solid" || raw.submit === true ? "primary" : "secondary";
}
