/** Shared by import and preview, including names reserved by archived bots. */
export function takeImportName(value: string, taken: Set<string>, maxLength = 100): string {
  const base = value.trim().slice(0, maxLength);
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}
