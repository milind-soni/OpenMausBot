const destinations = new WeakSet();
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const STILL_ESCAPES = new Set(["\\", "(", ")", "<", ">"]);
function enterDestination() {
  this.buffer();
  destinations.add(this.stack[this.stack.length - 1]);
}
function exitCharacterEscapeValue(token) {
  const tail = this.stack.pop();
  const value = this.sliceSerialize(token);
  const separator = destinations.has(this.stack[this.stack.length - 1])
    && DRIVE.test(tail.value)
    && !STILL_ESCAPES.has(value);
  tail.value += separator ? `\\${value}` : value;
  tail.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset };
}
export const windowsPathDestinations = {
  enter: { resourceDestinationString: enterDestination, definitionDestinationString: enterDestination },
  exit: { characterEscapeValue: exitCharacterEscapeValue },
};
