// GitHub pull request, issue and commit references in bot replies. Purely
// local: a URL or an owner/repo#N run is recognised by its shape, never
// fetched, so nothing leaves the app to render it.

/** "ref" is owner/repo#N: GitHub numbers issues and pull requests
 * together, so the text alone cannot say which it is. */
export type GithubRefKind = "pull" | "issue" | "commit" | "ref";

export type GithubRef = {
  kind: GithubRefKind;
  owner: string;
  repo: string;
  /** the issue or pull request number */
  number?: number;
  /** a commit's full or abbreviated sha */
  sha?: string;
  url: string;
};

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const URL_SHAPE = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/(pull|issues|commit)/([0-9]{1,7}|[0-9a-f]{7,40})(?:[/?#].*)?$`,
  "i",
);

/** A github.com pull request, issue or commit URL, or null. */
export function parseGithubUrl(href: string | undefined): GithubRef | null {
  if (!href) return null;
  const match = URL_SHAPE.exec(href.trim());
  if (!match) return null;
  const [, owner, repo, section, id] = match as unknown as [string, string, string, string, string];
  if (repo === "." || repo === "..") return null;
  const kind: GithubRefKind = section.toLowerCase() === "pull" ? "pull" : section.toLowerCase() === "issues" ? "issue" : "commit";
  if (kind === "commit") {
    if (!/^[0-9a-f]{7,40}$/i.test(id)) return null;
    return { kind, owner, repo, sha: id.toLowerCase(), url: href.trim() };
  }
  if (!/^[0-9]+$/.test(id) || Number(id) < 1) return null;
  return { kind, owner, repo, number: Number(id), url: href.trim() };
}

/** "owner/repo#123" in running text. Not preceded by a word, slash or dot,
 * so paths and URLs keep their own meaning. */
const SHORT_REF = new RegExp(`(?<![\\w/.@-])(${OWNER})/(${REPO})#([0-9]{1,7})(?![\\w-])`, "g");

export type TextSpan = { text: string; ref?: GithubRef };

/** Split text into plain runs and owner/repo#N references. GitHub sends
 * /issues/N to the pull request when N is one, so the link always works. */
export function splitShortRefs(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(SHORT_REF)) {
    const [whole, owner, repo, number] = match as unknown as [string, string, string, string];
    const start = match.index ?? 0;
    // a trailing dot belongs to the sentence, not the repo name
    if (repo.endsWith(".") || Number(number) < 1) continue;
    if (start > last) spans.push({ text: text.slice(last, start) });
    spans.push({
      text: whole,
      ref: { kind: "ref", owner, repo, number: Number(number), url: `https://github.com/${owner}/${repo}/issues/${number}` },
    });
    last = start + whole.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

/** The short label: "#123" or "abc1234" when every reference in the message
 * is to one repository, "repo#123" or "repo@abc1234" when they are mixed. */
export function githubRefLabel(ref: GithubRef, qualify: boolean): string {
  const id = ref.kind === "commit" ? ref.sha!.slice(0, 7) : `#${ref.number}`;
  if (!qualify) return id;
  return ref.kind === "commit" ? `${ref.repo}@${id}` : `${ref.repo}${id}`;
}

export const repoKey = (ref: GithubRef) => `${ref.owner}/${ref.repo}`.toLowerCase();

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[]; data?: Record<string, unknown> };

const SKIP = new Set(["link", "linkReference", "image", "imageReference", "definition", "html", "inlineCode", "code", "mention"]);

function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function refProperties(ref: GithubRef, label: string): Record<string, string> {
  return {
    "data-github-ref": ref.kind,
    "data-github-owner": ref.owner,
    "data-github-repo": ref.repo,
    ...(ref.number ? { "data-github-number": String(ref.number) } : {}),
    ...(ref.sha ? { "data-github-sha": ref.sha } : {}),
    "data-github-label": label,
  };
}

/** Remark plugin. A bare GitHub URL (its text is the URL itself) and an
 * owner/repo#N run become reference links the renderer draws as pills.
 * A link the bot gave its own words keeps them. */
export function remarkGithubRefs() {
  return (tree: MdNode) => {
    const found: { node: MdNode; ref: GithubRef }[] = [];
    const visit = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type === "link") {
          const ref = parseGithubUrl(child.url);
          const text = textOf(child).trim();
          if (ref && (text === child.url || text === child.url?.replace(/^https?:\/\//i, ""))) found.push({ node: child, ref });
          return [child];
        }
        if (SKIP.has(child.type)) return [child];
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return [child];
        }
        const spans = splitShortRefs(child.value);
        if (!spans.some((span) => span.ref)) return [child];
        return spans.map((span) => {
          if (!span.ref) return { type: "text", value: span.text };
          const link: MdNode = { type: "link", url: span.ref.url, children: [{ type: "text", value: span.text }] };
          found.push({ node: link, ref: span.ref });
          return link;
        });
      });
    };
    visit(tree);
    if (!found.length) return;
    const qualify = new Set(found.map(({ ref }) => repoKey(ref))).size > 1;
    for (const { node, ref } of found) {
      const label = githubRefLabel(ref, qualify);
      node.children = [{ type: "text", value: label }];
      node.data = { ...node.data, hProperties: { ...(node.data?.hProperties as object | undefined), ...refProperties(ref, label) } };
    }
  };
}

/** Read a reference back from the props react-markdown hands an <a>. */
export function githubRefFromProps(props: Record<string, unknown>, href: string | undefined): GithubRef | null {
  const kind = props["data-github-ref"];
  if (kind !== "pull" && kind !== "issue" && kind !== "commit" && kind !== "ref") return null;
  const owner = props["data-github-owner"], repo = props["data-github-repo"];
  if (typeof owner !== "string" || typeof repo !== "string" || !href) return null;
  const number = typeof props["data-github-number"] === "string" ? Number(props["data-github-number"]) : undefined;
  const sha = typeof props["data-github-sha"] === "string" ? props["data-github-sha"] : undefined;
  return { kind, owner, repo, ...(number ? { number } : {}), ...(sha ? { sha } : {}), url: href };
}
