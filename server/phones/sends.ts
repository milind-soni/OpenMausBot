// The sends a paired phone made, by sendId: a turn whose request line carries one was asked from the phone.
export interface PhoneSends {
  note(sendId: string): void;
  has(sendId: string | undefined): boolean;
}

export function createPhoneSends(limit = 500): PhoneSends {
  const ids = new Set<string>();
  return {
    note(sendId) {
      ids.delete(sendId);
      ids.add(sendId);
      for (const oldest of ids) {
        if (ids.size <= limit) break;
        ids.delete(oldest);
      }
    },
    has: (sendId) => sendId !== undefined && ids.has(sendId),
  };
}
