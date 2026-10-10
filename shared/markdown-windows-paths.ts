import type { CompileContext, Extension, Token } from "mdast-util-from-markdown";

// Markdown reads a backslash before punctuation as an escape, so a bot's link
// to C:\Users\me\.openmausbot\report.md parsed as C:\Users\me.openmausbot\report.md:
// the separator before ".openmausbot" (the default data folder on Windows),
// "_drafts" or "-old" was dropped and the link named a file that isn't there.
// In a link, image or definition destination that starts with a drive letter,
// such a backslash stays a path separator. "\\" and the destination's own
// delimiters "\(", "\)", "\<" and "\>" still escape, so a destination whose
// backslashes were already escaped reads as before. The server authorizes a
// file by the target it parses and the client sends the target it rendered,
// so both parse with this extension.

const destinations = new WeakSet<object>();
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const STILL_ESCAPES = new Set(["\\", "(", ")", "<", ">"]);

function enterDestination(this: CompileContext): undefined {
  this.buffer();
  destinations.add(this.stack[this.stack.length - 1]!);
}

function exitCharacterEscapeValue(this: CompileContext, token: Token): undefined {
  // The text node `characterEscape` opened, as mdast's own data handler pops it.
  const tail = this.stack.pop() as unknown as { value: string; position: { end: unknown } };
  const value = this.sliceSerialize(token);
  const separator = destinations.has(this.stack[this.stack.length - 1]!)
    && DRIVE.test(tail.value)
    && !STILL_ESCAPES.has(value);
  tail.value += separator ? `\\${value}` : value;
  tail.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset };
}

export const windowsPathDestinations: Extension = {
  enter: {
    resourceDestinationString: enterDestination,
    definitionDestinationString: enterDestination,
  },
  exit: {
    characterEscapeValue: exitCharacterEscapeValue,
  },
};
