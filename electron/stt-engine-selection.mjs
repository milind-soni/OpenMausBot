// Only the main process may grant an executable returned by its native picker.
// Grants belong to the selecting window and disappear when that window does.
export function createEngineSelection() {
  const picked = new WeakMap();
  return {
    grant(sender, executable) {
      if (!sender.isDestroyed() && typeof executable === 'string' && executable) picked.set(sender, executable);
    },
    resolve(sender, requested, saved) {
      if (requested === undefined) return saved || '';
      if (typeof requested !== 'string') throw Error('Choose the speech engine using the file picker.');
      if (requested === '' || requested === (saved || '')) return requested;
      if (!sender.isDestroyed() && picked.get(sender) === requested) return requested;
      throw Error('Choose the speech engine using the file picker.');
    },
  };
}
