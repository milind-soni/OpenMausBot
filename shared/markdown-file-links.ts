// Autolink local file references (.md, .txt, .json, file:// URLs, absolute paths)
// in bot message text, allowing them to render as links and authorize on the server.

export interface FileLinkMatch {
  start: number;
  end: number;
  raw: string;
  path: string;
}

const DOCUMENT_EXTENSIONS = new Set([
  "md", "markdown", "mdown", "mkdn",
  "txt", "text", "log",
  "json", "jsonl", "geojson",
  "csv", "tsv", "tab",
  "yaml", "yml", "toml", "ini", "conf",
  "xml", "svg", "html", "htm", "css", "scss", "less",
  "js", "mjs", "cjs", "jsx",
  "ts", "mts", "cts", "tsx",
  "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql",
  "diff", "patch",
  "pdf",
]);

export function isPreviewableDocument(pathOrName: string): boolean {
  const clean = pathOrName.split(/[?#]/, 1)[0]!;
  const ext = clean.split(".").pop()?.toLowerCase();
  // PDF is not viewed as text in our text viewer
  if (ext === "pdf") return false;
  return ext ? DOCUMENT_EXTENSIONS.has(ext) : false;
}

const TRAILING_PUNCTUATION = /[.,:;!?)\]>"']+$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const POSIX_START = /^\/[a-zA-Z0-9_.-]/;
const UNC_START = /^\\\\[a-zA-Z0-9_.-]/;

function hasKnownExtension(candidate: string): boolean {
  const clean = candidate.split(/[?#]/, 1)[0]!;
  const lastSlash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const basename = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
  // A dotfile like .env or .gitignore has no filename stem before the dot
  const dotIndex = basename.indexOf(".");
  if (dotIndex <= 0) return false;
  const lastDot = basename.lastIndexOf(".");
  const ext = basename.slice(lastDot + 1).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext) || /^[a-z0-9_-]{1,10}$/i.test(ext);
}

/**
 * Scan a text string for local file references:
 * - file://... URLs
 * - Angle-bracketed paths: <file:...> or </path...> or <C:\...>
 * - Absolute POSIX paths: /.../... with file extension
 * - Absolute Windows paths: C:\... or C:/... with file extension
 * - UNC paths: \\server\share\... with file extension
 */
export function findLocalFileReferences(text: string): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];
  if (!text || text.length < 4) return matches;

  // 1. Angle-bracketed local paths / URLs: <file:///...>, </path/to/file.ext>, <C:\...>
  const angleRegex = /<((?:file:\/\/[^>\r\n]+)|(?:(?:\/|[A-Za-z]:[\\/]|\\\\)[^>\r\n]+\.[a-zA-Z0-9_-]+))>/gi;
  let angleMatch: RegExpExecArray | null;
  while ((angleMatch = angleRegex.exec(text)) !== null) {
    const raw = angleMatch[0];
    const path = angleMatch[1]!;
    matches.push({
      start: angleMatch.index,
      end: angleMatch.index + raw.length,
      raw,
      path,
    });
  }

  // Helper to check if a range overlaps with existing matches
  const overlaps = (start: number, end: number): boolean =>
    matches.some((m) => Math.max(start, m.start) < Math.min(end, m.end));

  // 2. file:// URLs (not already angle-bracketed)
  const fileUrlRegex = /\bfile:\/\/[^\s<>"'`]+/gi;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileUrlRegex.exec(text)) !== null) {
    let raw = fileMatch[0];
    const matchStart = fileMatch.index;
    if (overlaps(matchStart, matchStart + raw.length)) continue;

    // Strip trailing punctuation
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    if (trimmed.length > 7) {
      matches.push({
        start: matchStart,
        end: matchStart + trimmed.length,
        raw: trimmed,
        path: trimmed,
      });
    }
  }

  // 3. Absolute POSIX paths (/path/to/file.ext), Windows paths (C:\... or C:/...), UNC paths
  // Must be preceded by start of string, whitespace, or opening delimiters: ( [ " ' < = :
  const pathRegex = /(^|[\s(["'<:=])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s<>"'`]+\.[a-zA-Z0-9_-]+)/g;
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = pathRegex.exec(text)) !== null) {
    const lead = pathMatch[1] ?? "";
    const rawCandidate = pathMatch[2]!;
    const start = pathMatch.index + lead.length;
    const end = start + rawCandidate.length;

    if (overlaps(start, end)) continue;

    // Ensure it's not a URL path part (e.g. preceded by :// or in a URL)
    if (lead === "/" && start > 1 && text[start - 2] === ":") continue;

    // Ensure it's not inside an escaped markdown link like \[label](/path)
    if (lead === "(" && start >= 2 && text[start - 2] === "]") continue;

    // Ensure it's not an XML/HTML tag attribute value (e.g. <attached-file path="...">)
    if ((lead === '"' || lead === "'") && start >= 6 && text.slice(Math.max(0, start - 15), start).includes("path=")) continue;

    // Strip trailing punctuation
    const cleanPath = rawCandidate.replace(TRAILING_PUNCTUATION, "");
    if (cleanPath.length < 3) continue;

    // Check that it's an absolute path
    const isWindows = WINDOWS_DRIVE.test(cleanPath) || UNC_START.test(cleanPath);
    const isPosix = POSIX_START.test(cleanPath) && cleanPath.includes("/", 1);

    if ((isWindows || isPosix) && hasKnownExtension(cleanPath)) {
      matches.push({
        start,
        end: start + cleanPath.length,
        raw: cleanPath,
        path: cleanPath,
      });
    }
  }

  // Sort matches by start position
  return matches.sort((a, b) => a.start - b.start);
}

export interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: any[];
  [key: string]: unknown;
}

const OPAQUE_NODES = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "code",
  "inlineCode",
  "definition",
  "html",
]);

/**
 * Mutate a Markdown AST (mdast), transforming detected local file paths
 * within text nodes into link nodes.
 */
export function transformLocalFileLinks(tree: any): void {
  const visit = (node: any) => {
    if (!node.children || OPAQUE_NODES.has(node.type)) return;
    node.children = node.children.flatMap((child: any) => {
      if (child.type !== "text" || !child.value) {
        visit(child);
        return [child];
      }
      const text = child.value;
      const refs = findLocalFileReferences(text);
      if (!refs.length) return [child];

      const result: any[] = [];
      let cursor = 0;
      for (const ref of refs) {
        if (ref.start > cursor) {
          result.push({ type: "text", value: text.slice(cursor, ref.start) });
        }
        result.push({
          type: "link",
          url: ref.path,
          children: [{ type: "text", value: ref.raw }],
        });
        cursor = ref.end;
      }
      if (cursor < text.length) {
        result.push({ type: "text", value: text.slice(cursor) });
      }
      return result;
    });
  };

  visit(tree);
}

/** Remark plugin to autolink local file references in Markdown. */
export function remarkLocalFileLinks() {
  return (tree: any) => {
    transformLocalFileLinks(tree);
  };
}
