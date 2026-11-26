import katex from "katex";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import remarkMath from "remark-math";

export const CJK_REGEX = /[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e\u3400-\u4dbf]/;
const LEGAL_TEXT_MACROS = new Set([
  "text",
  "mathrm",
  "mbox",
  "operatorname",
  "textbf",
  "textit",
  "textrm",
  "textsf",
  "texttt",
  "textnormal",
]);

export function hasIllegalCJK(text: string): boolean {
  if (!CJK_REGEX.test(text)) return false;
  let i = 0;
  let braceDepth = 0;
  const macroStack: number[] = [];

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      let macro = "";
      while (i < text.length && /[a-zA-Z]/.test(text[i]!)) {
        macro += text[i];
        i++;
      }
      if (LEGAL_TEXT_MACROS.has(macro)) {
        while (i < text.length && /\s/.test(text[i]!)) i++;
        if (text[i] === "{") {
          braceDepth++;
          macroStack.push(braceDepth);
          i++;
        }
      }
      continue;
    }
    if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      if (macroStack.length > 0 && macroStack[macroStack.length - 1] === braceDepth) {
        macroStack.pop();
      }
      braceDepth--;
      if (braceDepth < 0) braceDepth = 0;
    } else if (CJK_REGEX.test(ch)) {
      if (macroStack.length === 0) return true;
    }
    i++;
  }
  return false;
}

export function isBracesBalanced(text: string): boolean {
  let depth = 0;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/;
const MATH_BLOCK_BREAKER = /(?:^|\n)[ \t]*(?:#{1,6}\s|\|(?::?-+:?\|)+\s*(?:\n|$)|\|(?:[^|\r\n]+\|){2,}[ \t]*(?:\n|$)|[-*_]{3,}\s*(?:\n|$))/;
const CURRENCY_DOLLAR = /(?<![$\p{L}\p{N}])(?:R|US|AU|A|CA|C|NZ|HK|SG|S|MX|NT|BZ|Z)\$(?=[ \t\u00a0]?\d)/gu;

export function cleanInlineTeX(math: string): string {
  return math
    .replace(/\r?\n[ \t]*(?:>[ \t]*)+[ \t]*/g, "\n")
    .replace(/%[^\r\n]*(\r?\n|$)/g, " ")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

export function protectDisplayMath(text: string): { text: string; displayMath: string[] } {
  const display: string[] = [];
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] === "\\") {
      let backslashes = 1;
      while (i + backslashes < text.length && text[i + backslashes] === "\\") backslashes++;
      result += text.slice(i, i + backslashes);
      i += backslashes;
      continue;
    }

    if (text[i] === "$" && text[i + 1] === "$") {
      const start = i;
      let closeIndex = -1;
      let j = start + 2;
      while (j < text.length) {
        if (text[j] === "\\") {
          let b = 1;
          while (j + b < text.length && text[j + b] === "\\") b++;
          j += b;
          continue;
        }
        if (text[j] === "$" && text[j + 1] === "$") {
          closeIndex = j;
          break;
        }
        j++;
      }

      if (closeIndex === -1) {
        result += "\\$\\$";
        i += 2;
        continue;
      }

      const body = text.slice(start + 2, closeIndex);
      if (PARAGRAPH_BREAK.test(body) || MATH_BLOCK_BREAKER.test(body)) {
        result += "\\$\\$";
        i += 2;
        continue;
      }

      const token = `\\u0000OMB_MATH_${display.length}\\u0000`;
      const trimmed = body.replace(/^\n+|\n+$/g, "");
      const isIndented = start > 0 && /^[ \t]+$/.test(text.slice(Math.max(0, text.lastIndexOf("\n", start - 1) + 1), start));
      const fullMath = isIndented && !trimmed.includes("\n") ? `$$${trimmed}$$` : `$$\n${trimmed}\n$$`;
      display.push(fullMath);
      result += token;
      i = closeIndex + 2;
      continue;
    }

    result += text[i];
    i++;
  }

  return { text: result, displayMath: display };
}

export function escapeLiteralDollars(text: string): string {
  const { text: masked, displayMath } = protectDisplayMath(text);
  const hidden = masked.replace(CURRENCY_DOLLAR, (sign) => `${sign.slice(0, -1)}\\$`);
  const literal = new Set<number>();
  const singles: number[] = [];
  for (let i = 0; i < hidden.length; i++) {
    if (hidden[i] === "$" && hidden[i - 1] !== "\\") singles.push(i);
  }
  let open: number | null = null;
  for (const at of singles) {
    if (open !== null) {
      const span = hidden.slice(open, at);
      const closes = !span.includes("\n")
        && !/\s/.test(hidden[at - 1] ?? "")
        && !/\d/.test(hidden[at + 1] ?? "");
      if (closes) {
        open = null;
        continue;
      }
      literal.add(open);
    }
    open = /\S/.test(hidden[at + 1] ?? "") ? at : null;
    if (open === null) literal.add(at);
  }
  if (open !== null) literal.add(open);

  let escaped = "";
  for (let i = 0; i < hidden.length; i++) escaped += literal.has(i) ? "\\$" : hidden[i];
  displayMath.forEach((math, index) => {
    escaped = escaped.split(`\\u0000OMB_MATH_${index}\\u0000`).join(math);
  });
  return escaped;
}

function isLineEnding(code: number | null): boolean {
  return code === null || code === -5 || code === -4 || code === -3 || code === 10 || code === 13;
}

function isDigit(code: number | null): boolean {
  return code !== null && code >= 48 && code <= 57;
}

export function createStrictMathText(options: { singleDollarTextMath?: boolean } = {}) {
  const single = options.singleDollarTextMath ?? true;

  return {
    tokenize(effects: any, ok: any, nok: any) {
      let sizeOpen = 0;
      let sizeClose = 0;
      let token: any;
      let prevCode: number | null = null;
      const contentChars: number[] = [];
      let braceDepth = 0;
      let isEscaped = false;

      return start;

      function start(code: number | null) {
        effects.enter("mathText");
        effects.enter("mathTextSequence");
        return sequenceOpen(code);
      }

      function sequenceOpen(code: number | null) {
        if (code === 36) {
          effects.consume(code);
          sizeOpen++;
          return sequenceOpen;
        }

        if (sizeOpen < 2 && !single) {
          return nok(code);
        }

        if (sizeOpen === 1) {
          if (code === 32 || code === 9 || isLineEnding(code)) {
            return nok(code);
          }
        }

        effects.exit("mathTextSequence");
        return between(code);
      }

      function between(code: number | null): any {
        if (code === null) {
          return nok(code);
        }

        if (sizeOpen === 1 && isLineEnding(code)) {
          return nok(code);
        }

        if (code === 36) {
          token = effects.enter("mathTextSequence");
          sizeClose = 0;
          return sequenceClose(code);
        }

        if (sizeOpen === 1 && contentChars.length > 240) {
          return nok(code);
        }

        if (isEscaped) {
          isEscaped = false;
        } else if (code === 92) {
          isEscaped = true;
        } else if (code === 123) {
          braceDepth++;
        } else if (code === 125) {
          braceDepth--;
          if (braceDepth < 0) {
            return nok(code);
          }
        }

        token = effects.enter("mathTextData");
        contentChars.push(code);
        prevCode = code;
        effects.consume(code);
        return data;
      }

      function data(code: number | null): any {
        if (code === null) {
          effects.exit("mathTextData");
          return nok(code);
        }

        if (sizeOpen === 1 && isLineEnding(code)) {
          effects.exit("mathTextData");
          return nok(code);
        }

        if (code === 36) {
          effects.exit("mathTextData");
          token = effects.enter("mathTextSequence");
          sizeClose = 0;
          return sequenceClose(code);
        }

        if (code === 32 || code === 9) {
          effects.exit("mathTextData");
          return between(code);
        }

        if (sizeOpen === 1 && contentChars.length > 240) {
          effects.exit("mathTextData");
          return nok(code);
        }

        if (isEscaped) {
          isEscaped = false;
        } else if (code === 92) {
          isEscaped = true;
        } else if (code === 123) {
          braceDepth++;
        } else if (code === 125) {
          braceDepth--;
          if (braceDepth < 0) {
            effects.exit("mathTextData");
            return nok(code);
          }
        }

        contentChars.push(code);
        prevCode = code;
        effects.consume(code);
        return data;
      }

      function sequenceClose(code: number | null): any {
        if (code === 36) {
          effects.consume(code);
          sizeClose++;
          return sequenceClose;
        }

        if (sizeClose === sizeOpen) {
          if (sizeOpen === 1) {
            if (prevCode === 32 || prevCode === 9) {
              token.type = "mathTextData";
              return data(code);
            }
            if (braceDepth !== 0) {
              return nok(code);
            }
            const contentStr = String.fromCharCode(...contentChars);
            if (hasIllegalCJK(contentStr)) {
              return nok(code);
            }
            if (isDigit(code)) {
              token.type = "mathTextData";
              return data(code);
            }
          }

          effects.exit("mathTextSequence");
          effects.exit("mathText");
          return ok(code);
        }

        token.type = "mathTextData";
        return data(code);
      }
    },
    resolve(events: any) {
      let tailExitIndex = events.length - 4;
      let headEnterIndex = 3;
      let index: number;
      let enter: number | undefined;

      if (
        (events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") &&
        (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")
      ) {
        index = headEnterIndex;
        while (++index < tailExitIndex) {
          if (events[index][1].type === "mathTextData") {
            events[tailExitIndex][1].type = "mathTextPadding";
            events[headEnterIndex][1].type = "mathTextPadding";
            headEnterIndex += 2;
            tailExitIndex -= 2;
            break;
          }
        }
      }

      index = headEnterIndex - 1;
      tailExitIndex++;
      while (++index <= tailExitIndex) {
        if (enter === undefined) {
          if (index !== tailExitIndex && events[index][1].type !== "lineEnding") {
            enter = index;
          }
        } else if (index === tailExitIndex || events[index][1].type === "lineEnding") {
          events[enter][1].type = "mathTextData";
          if (index !== enter + 2) {
            events[enter][1].end = events[index - 1][1].end;
            events.splice(enter + 2, index - enter - 2);
            tailExitIndex -= index - enter - 2;
            index = enter + 2;
          }
          enter = undefined;
        }
      }
      return events;
    },
    previous(this: any, code: number | null): boolean {
      return code !== 36 || this.events[this.events.length - 1][1].type === "characterEscape";
    },
    name: "mathText",
  };
}

export function remarkStrictMath(this: any, options: any = {}) {
  remarkMath.call(this, options);

  const data = this.data();
  const extensions = data.micromarkExtensions || [];
  for (const ext of extensions) {
    if (ext && ext.text && ext.text[36]) {
      ext.text[36] = createStrictMathText(options);
    }
  }
}

function walkMdast(node: any, parent: any, visitor: (node: any, parent: any) => void) {
  if (!node) return;
  visitor(node, parent);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walkMdast(child, node, visitor);
    }
  }
}

export function remarkMathGuard() {
  return (tree: any) => {
    walkMdast(tree, null, (node: any, _parent: any) => {
      if (node.type === "inlineMath" || node.type === "math") {
        const val = typeof node.value === "string" ? node.value : "";
        const isInline = node.type === "inlineMath";
        let invalid = false;

        if (isInline && val.length > 240) invalid = true;
        if (!isInline && val.length > 5000) invalid = true;
        if (!invalid && !isBracesBalanced(val)) invalid = true;
        if (!invalid && hasIllegalCJK(val)) invalid = true;
        // oxlint-disable-next-line no-control-regex
        if (!invalid && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(val)) invalid = true;

        if (invalid) {
          node.type = "text";
          node.value = isInline ? `$${val}$` : `$$\n${val}\n$$`;
          delete node.data;
        }
      }
    });
  };
}

function hastToText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  if (Array.isArray(node.children)) {
    return node.children.map(hastToText).join("");
  }
  return "";
}

function walkHast(node: any, parents: any[], visitor: (element: any, parents: any[]) => void) {
  if (!node) return;
  if (node.type === "element") {
    visitor(node, parents);
  }
  if (Array.isArray(node.children)) {
    const nextParents = [...parents, node];
    for (const child of node.children) {
      walkHast(child, nextParents, visitor);
    }
  }
}

export function rehypeSafeKatex(options: any = {}) {
  return (tree: any) => {
    walkHast(tree, [], (element: any, parents: any[]) => {
      const classes = Array.isArray(element.properties?.className)
        ? element.properties.className
        : [];
      const languageMath = classes.includes("language-math");
      const mathDisplay = classes.includes("math-display");
      const mathInline = classes.includes("math-inline");

      if (!languageMath && !mathDisplay && !mathInline) return;

      let displayMode = mathDisplay;
      let targetNode = element;
      let parent = parents[parents.length - 1];

      if (
        element.tagName === "code" &&
        languageMath &&
        parent?.tagName === "pre"
      ) {
        targetNode = parent;
        parent = parents[parents.length - 2];
        displayMode = true;
      }

      if (!parent || !Array.isArray(parent.children)) return;

      const idx = parent.children.indexOf(targetNode);
      if (idx === -1) return;

      const value = hastToText(targetNode);
      let html: string | null = null;

      try {
        html = katex.renderToString(value, {
          ...options,
          displayMode,
          throwOnError: true,
        });
      } catch {
        html = null;
      }

      if (html !== null) {
        const root = fromHtmlIsomorphic(html, { fragment: true });
        parent.children.splice(idx, 1, ...root.children);
      } else {
        const fallbackNode = displayMode
          ? {
              type: "element",
              tagName: "pre",
              properties: {
                className: ["katex-fallback-block", "font-mono", "text-inherit", "my-2", "overflow-x-auto"],
              },
              children: [{ type: "text", value: `$$\n${value}\n$$` }],
            }
          : {
              type: "element",
              tagName: "span",
              properties: {
                className: ["katex-fallback", "font-mono", "text-inherit"],
              },
              children: [{ type: "text", value: `$${value}$` }],
            };
        parent.children.splice(idx, 1, fallbackNode);
      }
    });
  };
}
