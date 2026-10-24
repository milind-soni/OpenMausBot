import {
  MAX_CUSTOM_MASCOT_NAME,
  MAX_CUSTOM_MASCOT_POINTS,
  isSimpleClosedOutline,
  normalizeMascotName,
  type CustomMascotPoint,
} from "../../shared/mascot-profile.ts";
import { FACE_BOX } from "../../shared/cursor-face-data.ts";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const MAX_SVG_BYTES = 128 * 1024;
const MAX_PATH_COMMANDS = 4_096;
const MAX_PATH_COORDINATE = 1_000_000;
const SAMPLE_COUNT = MAX_CUSTOM_MASCOT_POINTS;
const MIN_EDGE_LENGTH = 0.001;
const XML_WHITESPACE = /[\t\n\r ]/u;
const ROOT_ATTRIBUTES = new Set(["xmlns", "viewBox", "width", "height", "version", "id", "class"]);
const PATH_ATTRIBUTES = new Set([
  "d",
  "id",
  "class",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "clip-rule",
  "color",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "shape-rendering",
  "vector-effect",
]);

export interface ImportedCustomMascotSvg {
  name: string;
  outline: readonly CustomMascotPoint[];
}

interface StartTag {
  name: string;
  attributes: Map<string, string>;
  selfClosing: boolean;
  nextIndex: number;
}

interface PathCommandToken {
  kind: "command";
  value: string;
}

interface PathNumberToken {
  kind: "number";
  value: number;
  raw: string;
}

type PathToken = PathCommandToken | PathNumberToken;

/**
 * Accept a tightly constrained one-path SVG, sample it in a detached SVG path,
 * then return only normalized name and numeric outline data.
 */
export function importCustomMascotSvg(svgMarkup: string, filename: string): ImportedCustomMascotSvg {
  if (typeof svgMarkup !== "string" || typeof filename !== "string") {
    invalidSvg("source and filename must be text");
  }
  if (new TextEncoder().encode(svgMarkup).byteLength > MAX_SVG_BYTES) {
    invalidSvg("file is larger than the import limit");
  }

  const checkedPathData = extractSinglePathData(svgMarkup);
  validatePathData(checkedPathData);
  const sampled = sampleDetachedPath(checkedPathData);
  const outline = normalizeOutline(sampled);
  return { name: defaultNameFromFilename(filename), outline };
}

function extractSinglePathData(markup: string): string {
  let index = markup.charCodeAt(0) === 0xfeff ? 1 : 0;
  index = skipWhitespaceAndComments(markup, index);

  if (markup.startsWith("<?xml", index)) {
    const end = markup.indexOf("?>", index + 5);
    if (end < 0) invalidSvg("XML declaration is incomplete");
    const declaration = markup.slice(index, end + 2);
    if (!/^<\?xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/iu.test(declaration)) {
      invalidSvg("XML declaration is unsupported");
    }
    index = skipWhitespaceAndComments(markup, end + 2);
  }

  const root = readStartTag(markup, index);
  if (root.name !== "svg" || root.selfClosing) invalidSvg("document must have one SVG root");
  validateRootAttributes(root.attributes);
  index = root.nextIndex;

  let pathData: string | undefined;
  while (true) {
    index = skipWhitespaceAndComments(markup, index);
    if (markup.startsWith("</", index)) {
      index = readEndTag(markup, index, "svg");
      break;
    }
    if (index >= markup.length || markup[index] !== "<") {
      invalidSvg("SVG root may contain only one direct path");
    }

    const child = readStartTag(markup, index);
    if (child.name !== "path") invalidSvg("SVG may contain only a direct path element");
    if (pathData !== undefined) invalidSvg("SVG must contain exactly one path");
    validatePathAttributes(child.attributes);
    pathData = child.attributes.get("d");
    if (pathData === undefined) invalidSvg("path is missing its d attribute");
    index = child.nextIndex;

    if (!child.selfClosing) {
      index = skipWhitespaceAndComments(markup, index);
      index = readEndTag(markup, index, "path");
    }
  }

  index = skipWhitespaceAndComments(markup, index);
  if (index !== markup.length) invalidSvg("unexpected content after SVG root");
  if (pathData === undefined) invalidSvg("SVG must contain exactly one path");
  return pathData;
}

function validateRootAttributes(attributes: Map<string, string>): void {
  const namespace = attributes.get("xmlns");
  if (namespace !== SVG_NAMESPACE) invalidSvg("SVG root must use the SVG namespace");

  for (const [name, value] of attributes) {
    rejectActiveAttribute(name, value);
    if (!ROOT_ATTRIBUTES.has(name)) invalidSvg("SVG root has an unsupported attribute");
    if (name === "viewBox") validateViewBox(value);
    if (name === "width" || name === "height") validateLength(value);
    if (name === "version" && value !== "1.0" && value !== "1.1") {
      invalidSvg("SVG version is unsupported");
    }
  }
}

function validatePathAttributes(attributes: Map<string, string>): void {
  if (!attributes.has("d")) invalidSvg("path is missing its d attribute");
  for (const [name, value] of attributes) {
    rejectActiveAttribute(name, value);
    if (!PATH_ATTRIBUTES.has(name)) invalidSvg("path has an unsupported attribute");
  }
}

function rejectActiveAttribute(name: string, value: string): void {
  const lowerName = name.toLowerCase();
  if (
    lowerName.startsWith("on") ||
    lowerName === "style" ||
    lowerName === "transform" ||
    lowerName === "href" ||
    lowerName.endsWith(":href") ||
    lowerName === "src" ||
    lowerName === "filter" ||
    lowerName === "mask" ||
    lowerName === "clip-path" ||
    lowerName.startsWith("marker-")
  ) {
    invalidSvg("active attributes and references are unsupported");
  }
  if (name !== "xmlns" && /url\s*\(|\b(?:https?|ftp|file|data|javascript):|(?:^|\s)\/\//iu.test(value)) {
    invalidSvg("foreign resources are unsupported");
  }
}

function validateViewBox(value: string): void {
  const numberPattern = /[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/gu;
  const rawNumbers = value.match(numberPattern) ?? [];
  const remainder = value.replace(numberPattern, "").replace(/[\s,]+/gu, "");
  if (rawNumbers.length !== 4 || remainder !== "") invalidSvg("viewBox is malformed");

  const [x, y, width, height] = rawNumbers.map(Number);
  if (
    ![x, y, width, height].every((number) => Number.isFinite(number) && Math.abs(number) <= MAX_PATH_COORDINATE) ||
    width! <= 0 ||
    height! <= 0
  ) {
    invalidSvg("viewBox is outside the supported bounds");
  }
}

function validateLength(value: string): void {
  const match = value.trim().match(/^([+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?)(?:px|pt|pc|mm|cm|in|em|ex|%)?$/iu);
  if (!match) invalidSvg("SVG dimensions are malformed");
  const length = Number(match[1]);
  if (!Number.isFinite(length) || length <= 0 || length > MAX_PATH_COORDINATE) {
    invalidSvg("SVG dimensions are outside the supported bounds");
  }
}

function readStartTag(source: string, start: number): StartTag {
  if (source[start] !== "<" || source[start + 1] === "/" || source[start + 1] === "!" || source[start + 1] === "?") {
    invalidSvg("expected an SVG element");
  }
  let index = start + 1;
  const nameStart = index;
  index = readXmlName(source, index);
  const name = source.slice(nameStart, index);
  const attributes = new Map<string, string>();

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === ">") return { name, attributes, selfClosing: false, nextIndex: index + 1 };
    if (source[index] === "/" && source[index + 1] === ">") {
      return { name, attributes, selfClosing: true, nextIndex: index + 2 };
    }

    const attributeStart = index;
    index = readXmlName(source, index);
    const attributeName = source.slice(attributeStart, index);
    if (attributes.has(attributeName)) invalidSvg("duplicate XML attribute");
    index = skipWhitespace(source, index);
    if (source[index] !== "=") invalidSvg("XML attribute is missing its value");
    index = skipWhitespace(source, index + 1);

    const quote = source[index];
    if (quote !== "\"" && quote !== "'") invalidSvg("XML attributes must be quoted");
    const valueStart = index + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) invalidSvg("XML attribute is not closed");
    const value = source.slice(valueStart, valueEnd);
    if (value.includes("<") || value.includes("&")) invalidSvg("XML entities are unsupported");
    attributes.set(attributeName, value);
    index = valueEnd + 1;
  }

  invalidSvg("XML element is incomplete");
}

function readXmlName(source: string, start: number): number {
  if (start >= source.length || !/[A-Za-z_:]/u.test(source[start]!)) {
    invalidSvg("XML name is malformed");
  }
  let index = start + 1;
  while (index < source.length && /[A-Za-z0-9_.:-]/u.test(source[index]!)) index++;
  return index;
}

function readEndTag(source: string, start: number, expectedName: string): number {
  if (!source.startsWith("</", start)) invalidSvg("SVG element is not closed");
  let index = start + 2;
  const nameStart = index;
  index = readXmlName(source, index);
  if (source.slice(nameStart, index) !== expectedName) invalidSvg("SVG element closing tag does not match");
  index = skipWhitespace(source, index);
  if (source[index] !== ">") invalidSvg("SVG closing tag is malformed");
  return index + 1;
}

function skipWhitespaceAndComments(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (!source.startsWith("<!--", index)) return index;
    const end = source.indexOf("-->", index + 4);
    if (end < 0) invalidSvg("XML comment is incomplete");
    if (source.slice(index + 4, end).includes("--")) invalidSvg("XML comment is malformed");
    index = end + 3;
  }
  return index;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && XML_WHITESPACE.test(source[index]!)) index++;
  return index;
}

function validatePathData(pathData: string): void {
  const tokens = tokenizePathData(pathData);
  if (tokens.length < 4 || tokens[0]?.kind !== "command" || !isMoveCommand(tokens[0].value)) {
    invalidSvg("path must start with one move command");
  }

  let index = 0;
  let sawMove = false;
  let closed = false;
  let commandCount = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || token.kind !== "command") invalidSvg("path command is malformed");
    const command = token.value;
    index++;

    if (isCloseCommand(command)) {
      if (!sawMove || index !== tokens.length) invalidSvg("closed path must end with one close command");
      closed = true;
      commandCount++;
      break;
    }
    if (isMoveCommand(command)) {
      if (sawMove) invalidSvg("multiple path subpaths are unsupported");
      sawMove = true;
    } else if (!sawMove) {
      invalidSvg("path must start with a move command");
    }

    const arity = commandArity(command);
    const groupStart = index;
    while (index < tokens.length && tokens[index]?.kind === "number") index++;
    const numberCount = index - groupStart;
    if (numberCount === 0 || numberCount % arity !== 0) invalidSvg("path command has incomplete parameters");

    const groupCount = numberCount / arity;
    commandCount += groupCount;
    if (commandCount > MAX_PATH_COMMANDS) invalidSvg("path has too many commands");

    if (command.toLowerCase() === "a") {
      for (let group = groupStart; group < index; group += arity) {
        const rx = tokens[group];
        const ry = tokens[group + 1];
        const largeArc = tokens[group + 3];
        const sweep = tokens[group + 4];
        if (
          rx?.kind !== "number" ||
          ry?.kind !== "number" ||
          largeArc?.kind !== "number" ||
          sweep?.kind !== "number" ||
          rx.value < 0 ||
          ry.value < 0 ||
          (largeArc.raw !== "0" && largeArc.raw !== "1") ||
          (sweep.raw !== "0" && sweep.raw !== "1")
        ) {
          invalidSvg("arc radii and flags are invalid");
        }
      }
    }
  }

  if (!sawMove || !closed) invalidSvg("path must be explicitly closed");
}

function tokenizePathData(pathData: string): PathToken[] {
  const tokens: PathToken[] = [];
  const pathNumber = /[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/y;
  let index = 0;
  let previousKind: PathToken["kind"] | undefined;
  let commaPending = false;
  let activeCommand: string | null = null;
  let commandParameterIndex = 0;

  while (index < pathData.length) {
    if (XML_WHITESPACE.test(pathData[index]!)) {
      index++;
      continue;
    }
    if (pathData[index] === ",") {
      if (previousKind !== "number" || commaPending) invalidSvg("path separators are malformed");
      commaPending = true;
      index++;
      continue;
    }

    const character = pathData[index]!;
    if (/[A-Za-z]/u.test(character)) {
      if (!/[MmLlHhVvCcSsQqTtAaZz]/u.test(character)) invalidSvg("path uses an unsupported command");
      if (commaPending) invalidSvg("path separators are malformed");
      tokens.push({ kind: "command", value: character });
      previousKind = "command";
      activeCommand = character.toLowerCase() === "z" ? null : character;
      commandParameterIndex = 0;
      index++;
    } else {
      const arcFlagPosition = activeCommand?.toLowerCase() === "a" && (commandParameterIndex === 3 || commandParameterIndex === 4);
      let raw: string;
      if (arcFlagPosition && (character === "0" || character === "1")) {
        raw = character;
        index++;
      } else {
        pathNumber.lastIndex = index;
        const match = pathNumber.exec(pathData);
        if (!match) invalidSvg("path contains an invalid number");
        raw = match[0];
        index = pathNumber.lastIndex;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || Math.abs(value) > MAX_PATH_COORDINATE) {
        invalidSvg("path coordinate is outside the supported bounds");
      }
      tokens.push({ kind: "number", raw, value });
      previousKind = "number";
      commaPending = false;
      if (activeCommand !== null) {
        commandParameterIndex = (commandParameterIndex + 1) % commandArity(activeCommand);
      }
    }

    if (tokens.length > MAX_PATH_COMMANDS * 8 + 1) invalidSvg("path has too many parameters");
  }

  if (commaPending) invalidSvg("path separators are malformed");
  return tokens;
}

function commandArity(command: string): number {
  switch (command.toLowerCase()) {
    case "m":
    case "l":
    case "t":
      return 2;
    case "h":
    case "v":
      return 1;
    case "c":
      return 6;
    case "s":
    case "q":
      return 4;
    case "a":
      return 7;
    default:
      invalidSvg("path command is unsupported");
  }
}

function sampleDetachedPath(pathData: string): CustomMascotPoint[] {
  if (!globalThis.document) invalidSvg("SVG path sampling requires a browser document");

  let path: SVGPathElement;
  try {
    path = globalThis.document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
  } catch {
    invalidSvg("could not create a detached SVG path");
  }
  if (path.parentNode !== null || path.isConnected) invalidSvg("SVG path must remain detached");

  let totalLength: number;
  try {
    totalLength = path.getTotalLength();
  } catch {
    invalidSvg("browser could not measure the SVG path");
  }
  if (!Number.isFinite(totalLength) || totalLength <= 0) invalidSvg("path has no measurable outline");

  const points: CustomMascotPoint[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    let point: DOMPoint;
    try {
      point = path.getPointAtLength((totalLength * index) / SAMPLE_COUNT);
    } catch {
      invalidSvg("browser could not sample the SVG path");
    }
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      Math.abs(point.x) > MAX_PATH_COORDINATE ||
      Math.abs(point.y) > MAX_PATH_COORDINATE
    ) {
      invalidSvg("sampled path coordinate is outside the supported bounds");
    }
    points.push([point.x, point.y]);
  }
  return points;
}

function normalizeOutline(points: readonly CustomMascotPoint[]): CustomMascotPoint[] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const longestSide = Math.max(width, height);
  if (!Number.isFinite(longestSide) || longestSide <= 0) invalidSvg("path must enclose a nonzero area");

  const scale = FACE_BOX / longestSide;
  const xOffset = (FACE_BOX - width * scale) / 2;
  const yOffset = (FACE_BOX - height * scale) / 2;
  const outline: CustomMascotPoint[] = [];

  for (const [x, y] of points) {
    const next: CustomMascotPoint = [round((x - minX) * scale + xOffset), round((y - minY) * scale + yOffset)];
    const previous = outline.at(-1);
    if (previous && distance(previous, next) < MIN_EDGE_LENGTH) continue;
    outline.push(next);
  }
  if (outline.length > 1 && distance(outline[0]!, outline.at(-1)!) < MIN_EDGE_LENGTH) outline.pop();
  if (!isSimpleClosedOutline(outline)) invalidSvg("path must form one simple closed outline");
  return outline;
}

function defaultNameFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/u).at(-1) ?? "";
  const stem = basename.replace(/\.[^.]*$/u, "");
  const normalized = normalizeMascotName(stem);
  let limited = "";
  for (const character of normalized) {
    if (limited.length + character.length > MAX_CUSTOM_MASCOT_NAME) break;
    limited += character;
  }
  return normalizeMascotName(limited) || "Custom Mascot";
}

function round(value: number): number {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function distance(a: CustomMascotPoint, b: CustomMascotPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function isMoveCommand(command: string): boolean {
  return command === "M" || command === "m";
}

function isCloseCommand(command: string): boolean {
  return command === "Z" || command === "z";
}

function invalidSvg(reason: string): never {
  throw new Error("Invalid custom mascot SVG: " + reason);
}
