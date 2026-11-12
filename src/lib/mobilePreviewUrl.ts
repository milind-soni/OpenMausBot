export type PreviewFileKind = "html" | "pdf" | "markdown" | "image";

export interface PreviewUrlSource {
  kind: "url";
  url: string;
  raw: string;
  isLocalOrPrivate: boolean;
}

export interface PreviewFileSource {
  kind: "file";
  projectId: string;
  projectName?: string;
  filePath: string;
  fileType: PreviewFileKind;
}

export type PreviewSource = PreviewUrlSource | PreviewFileSource;

export interface PreviewUrlResult {
  valid: boolean;
  url: string;
  error?: string;
  isLocalOrPrivate: boolean;
}

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^\[::1\]$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
];

const LOCAL_HOSTNAMES = ["localhost", "0.0.0.0", "host.docker.internal", "127.0.0.1"];

function isLocalOrPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.includes(lower) || lower.endsWith(".local") || lower.endsWith(".localhost")) {
    return true;
  }
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(lower)) {
      return true;
    }
  }
  return false;
}

const FILE_EXT_MAP: Record<string, PreviewFileKind> = {
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
};

export function detectPreviewFileKind(filePath: string): PreviewFileKind | null {
  const trimmed = filePath.trim().toLowerCase();
  const dotIdx = trimmed.lastIndexOf(".");
  if (dotIdx < 0) return null;
  const ext = trimmed.slice(dotIdx);
  return FILE_EXT_MAP[ext] ?? null;
}

export function buildProjectFilePreviewUrl(projectId: string, filePath: string, cacheBust?: number): string {
  const cleanRel = filePath
    .replace(/^[/\\]+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const base = `/api/preview/file/${encodeURIComponent(projectId)}/${cleanRel}`;
  return cacheBust ? `${base}?t=${cacheBust}` : base;
}

export function describePreviewSource(source: PreviewSource | null): string {
  if (!source) return "";
  if (source.kind === "url") return source.url;
  return source.projectName ? `${source.projectName}/${source.filePath}` : source.filePath;
}

export function validatePreviewUrl(input: string): PreviewUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, url: "", error: "Please enter a web address or choose a file", isLocalOrPrivate: false };
  }

  if (/^(javascript|data|file|vbscript|about|blob|chrome|edge):/i.test(trimmed)) {
    return {
      valid: false,
      url: trimmed,
      error: "Unsupported protocol. Only http:// and https:// are allowed.",
      isLocalOrPrivate: false,
    };
  }

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    const hostCandidate = normalized.split("/")[0].split(":")[0];
    if (isLocalOrPrivateHost(hostCandidate)) {
      normalized = `http://${normalized}`;
    } else {
      normalized = `https://${normalized}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return {
      valid: false,
      url: trimmed,
      error: "Invalid URL format. Example: http://localhost:3000 or https://example.com",
      isLocalOrPrivate: false,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      url: trimmed,
      error: "Only http:// and https:// URLs are allowed.",
      isLocalOrPrivate: false,
    };
  }

  if (!parsed.hostname) {
    return { valid: false, url: trimmed, error: "URL is missing a hostname.", isLocalOrPrivate: false };
  }

  const isLocal = isLocalOrPrivateHost(parsed.hostname);
  return {
    valid: true,
    url: parsed.toString(),
    isLocalOrPrivate: isLocal,
  };
}
