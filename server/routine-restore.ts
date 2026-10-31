export function fieldsRestorer<T extends object>(target: T): () => void {
  const before = { ...target };
  return () => { Object.assign(target, Object.fromEntries(Object.keys(target).map((key) => [key, undefined])), before); };
}
