// The server's word that its Apps catalog changed, passed on to whoever holds a copy. It imports nothing, so the store
// can send it without loading the catalog.
const hearers = new Set<() => void>();

export function appCatalogAnnounced(): void {
  for (const hear of hearers) hear();
}

export function onAppCatalogAnnounced(hear: () => void): () => void {
  hearers.add(hear);
  return () => hearers.delete(hear);
}
