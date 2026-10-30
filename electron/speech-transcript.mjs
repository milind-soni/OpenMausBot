export function createSpeechTranscript() {
  let committed = "";
  let current = "";
  let boundary = false;
  let boundaryText = "";
  let finalStart = null;
  const join = (left, right) => left && right ? `${left} ${right}` : left || right;

  return line => {
    if (typeof line.text !== "string") return line;
    let text = line.text.trim();
    if (!text) return { ...line, text: join(committed, current) };
    const hasFinalTiming = line.utteranceFinal === true && Number.isFinite(line.speechStart);
    const nextStart = hasFinalTiming ? line.speechStart : null;
    const newUtterance = nextStart !== null && finalStart !== null && nextStart > finalStart + 0.01;

    if (!newUtterance && committed && text.startsWith(committed)) {
      text = text.slice(committed.length).trimStart();
    }
    if (!text) return { ...line, text: join(committed, current) };

    if (boundary) {
      const sameFinalAudio = hasFinalTiming && nextStart === finalStart
        && (text.startsWith(boundaryText) || boundaryText.startsWith(text));
      if (!newUtterance && (text === boundaryText || sameFinalAudio)) {
        current = text;
        boundaryText = text;
        return { ...line, text: join(committed, current) };
      }
      if (newUtterance || !text.startsWith(boundaryText)) {
        committed = join(committed, boundaryText);
        boundary = false;
      }
    }
    current = text;
    if (line.utteranceFinal === true || line.partial === false) {
      boundary = true;
      boundaryText = current;
    }
    if (hasFinalTiming) finalStart = nextStart;
    return { ...line, text: join(committed, current) };
  };
}
