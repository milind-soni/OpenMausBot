export function displayModelLabel(label: string, provider: string, custom = false): string {
  if (custom || !provider || /\d/.test(label) || label.toLowerCase().startsWith(provider.toLowerCase())) return label;
  return `${provider} ${label}`;
}

export function shortModelLabel(label: string, family: string): string {
  const prefix = `${family} `;
  if (!family || label.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return label;
  const rest = label.slice(prefix.length).trimStart();
  return /^\p{L}{2}/u.test(rest) ? rest : label;
}
