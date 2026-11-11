import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { FILE_MAX_BYTES, sanitizeSharedFileName, saveFile, type SavedFile } from "./attachments.ts";
import { extractZipMember, readZipDirectory } from "./zip-archive.ts";

export const XMIND_MIME = "application/vnd.xmind.workbook";

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_TOPICS = 100_000;
const MAX_XML_ELEMENTS = 500_000;

interface Topic {
  title: string;
  note: string;
  labels: string[];
  markers: string[];
  href: string;
  floating: boolean;
  children: Topic[];
}

interface Sheet {
  title: string;
  root: Topic | null;
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function topicFromJson(raw: unknown, budget: { topics: number }, floating = false): Topic {
  if (--budget.topics < 0) throw new Error("too many topics");
  const topic = record(raw);
  return {
    title: text(topic.title),
    note: text(record(record(topic.notes).plain).content),
    labels: list(topic.labels).map(text).filter(Boolean),
    markers: list(topic.markers).map((marker) => text(record(marker).markerId)).filter(Boolean),
    href: text(topic.href),
    floating,
    children: Object.entries(record(topic.children)).flatMap(([group, topics]) =>
      list(topics).map((child) => topicFromJson(child, budget, group === "detached")),
    ),
  };
}

/** `content.json`, the format XMind has written since XMind Zen (2018): an array of sheets, each with a `rootTopic`. */
export function outlineFromJson(source: string): string {
  const budget = { topics: MAX_TOPICS };
  const sheets = list(JSON.parse(source)).map((raw): Sheet => {
    const sheet = record(raw);
    return { title: text(sheet.title), root: sheet.rootTopic ? topicFromJson(sheet.rootTopic, budget) : null };
  });
  return renderSheets(sheets);
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
    if (named) return XML_ENTITIES[named] ?? entity;
    const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

const localName = (name: string): string => name.slice(name.indexOf(":") + 1);

/** Elements, attributes, text and CDATA only, with namespace prefixes dropped; a `>` inside an attribute value ends the
 * tag early, which XMind never writes (it escapes it). */
function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "", attrs: {}, children: [], text: "" };
  const stack = [root];
  let cursor = 0;
  let elements = 0;
  while (cursor < source.length) {
    const top = stack[stack.length - 1]!;
    const open = source.indexOf("<", cursor);
    if (open < 0) break;
    top.text += decodeXml(source.slice(cursor, open));
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end < 0) break;
      top.text += source.slice(open + 9, end);
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    const close = source.indexOf(">", open);
    if (close < 0) break;
    const tag = source.slice(open + 1, close);
    cursor = close + 1;
    if (tag.startsWith("?") || tag.startsWith("!")) continue;
    if (tag.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (++elements > MAX_XML_ELEMENTS) throw new Error("too many elements");
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameEnd = body.search(/\s/);
    const node: XmlNode = { name: localName(nameEnd < 0 ? body : body.slice(0, nameEnd)), attrs: {}, children: [], text: "" };
    if (nameEnd >= 0) {
      for (const match of body.slice(nameEnd).matchAll(/\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy)) {
        node.attrs[localName(match[1]!)] = decodeXml(match[2] ?? match[3] ?? "");
      }
    }
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const child = (node: XmlNode | undefined, name: string): XmlNode | undefined =>
  node?.children.find((candidate) => candidate.name === name);
const children = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node?.children.filter((candidate) => candidate.name === name) ?? [];

function topicFromXml(node: XmlNode, floating = false): Topic {
  return {
    title: child(node, "title")?.text ?? "",
    note: child(child(node, "notes"), "plain")?.text ?? "",
    labels: children(child(node, "labels"), "label").map((label) => label.text).filter(Boolean),
    markers: children(child(node, "marker-refs"), "marker-ref").map((marker) => marker.attrs["marker-id"] ?? "").filter(Boolean),
    href: node.attrs.href ?? "",
    floating,
    children: children(child(node, "children"), "topics").flatMap((group) =>
      children(group, "topic").map((topic) => topicFromXml(topic, group.attrs.type === "detached")),
    ),
  };
}

/** `content.xml`, the format of XMind 8 and earlier: `xmap-content` holding `sheet` elements, each with one root `topic`. */
export function outlineFromXml(source: string): string {
  const sheets = children(child(parseXml(source), "xmap-content"), "sheet").map((sheet): Sheet => {
    const root = child(sheet, "topic");
    return { title: child(sheet, "title")?.text ?? "", root: root ? topicFromXml(root) : null };
  });
  return renderSheets(sheets);
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

function renderTopic(topic: Topic, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  const details = [
    topic.floating ? "floating" : "",
    topic.labels.length ? `labels: ${topic.labels.map(oneLine).join(", ")}` : "",
    topic.markers.length ? `markers: ${topic.markers.map(oneLine).join(", ")}` : "",
    topic.href ? `link: ${oneLine(topic.href)}` : "",
  ].filter(Boolean).join("; ");
  lines.push(`${indent}- ${oneLine(topic.title) || "(untitled)"}${details ? ` (${details})` : ""}`);
  for (const line of topic.note.split(/\r?\n/)) {
    if (line.trim()) lines.push(`${indent}  > ${line.trim()}`);
  }
  for (const next of topic.children) renderTopic(next, depth + 1, lines);
}

function renderSheets(sheets: Sheet[]): string {
  if (!sheets.length) throw new Error("no sheets");
  return sheets.map((sheet, index) => {
    const lines = [`# ${oneLine(sheet.title) || `Sheet ${index + 1}`}`, ""];
    if (sheet.root) renderTopic(sheet.root, 0, lines);
    return lines.join("\n");
  }).join("\n\n") + "\n";
}

async function outlineFromArchive(archive: string, scratch: string): Promise<string> {
  const members = await readZipDirectory(archive, MAX_ARCHIVE_ENTRIES);
  const member = members.find((entry) => entry.name === "content.json") ?? members.find((entry) => entry.name === "content.xml");
  if (!member || member.uncompressedBytes > MAX_CONTENT_BYTES) throw new Error("no readable content");
  const extracted = join(scratch, "content");
  await extractZipMember(archive, member, extracted, 0o600);
  const source = await readFile(extracted, "utf8");
  return member.name === "content.json" ? outlineFromJson(source) : outlineFromXml(source);
}

/** An uploaded `.xmind` is a ZIP, which the attachment store never holds: what is saved is its Markdown outline, under
 * the upload's name plus `.md`. The archive itself only ever exists in a temporary folder removed before returning. */
export async function saveXmindUpload(
  chunks: AsyncIterable<Uint8Array>,
  originalName: string,
  options: { uploadId?: string } = {},
): Promise<SavedFile> {
  const name = `${originalName}.md`;
  sanitizeSharedFileName(name, "text/markdown");
  const scratch = await mkdtemp(join(tmpdir(), "omb-xmind-"));
  try {
    const archive = join(scratch, "map.xmind");
    let bytes = 0;
    await pipeline(
      chunks,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          if (bytes > FILE_MAX_BYTES) throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
          yield chunk;
        }
      },
      createWriteStream(archive, { mode: 0o600 }),
    );
    if (bytes === 0) throw statusError(400, "empty file");
    let outline: string;
    try {
      outline = await outlineFromArchive(archive, scratch);
    } catch {
      throw statusError(400, "not a readable XMind file");
    }
    return await saveFile((async function* () { yield Buffer.from(outline, "utf8"); })(), name, "text/markdown", {
      uploadId: options.uploadId,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
