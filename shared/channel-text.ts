import { fromMarkdown } from "mdast-util-from-markdown";
type RootContent = ReturnType<typeof fromMarkdown>["children"][number];

/** Plain text for ordinary carrier prose. Approval details must bypass this. */
export function formatChannelText(text: string): string {
  // CommonMark can parse emphasis inside a bare URL. Protect those exact bytes
  // before parsing, including URLs used as link destinations or code examples.
  const urls: string[] = [];
  let token = "OMBURLTOKEN";
  while (text.includes(token)) token += "X";
  const protectedText = text.replace(/https?:\/\/[^\s<>"'`\])]+/g, url => `${token}${urls.push(url) - 1}END`);
  const tree = fromMarkdown(protectedText);
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: RootContent) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if ("children" in node) node.children.forEach(collectDefinitions);
  };
  tree.children.forEach(collectDefinitions);
  const render = (node: RootContent): string => {
    switch (node.type) {
      case "text": case "inlineCode": case "code": case "html": return node.value;
      case "break": return "\n";
      case "thematicBreak": return "—";
      case "image": return node.alt ? `${node.alt} (${node.url})` : node.url;
      case "link": {
        const label = node.children.map(render).join("");
        return label === node.url ? label : `${label} (${node.url})`;
      }
      case "linkReference": case "imageReference": {
        const label = node.type === "linkReference" ? node.children.map(render).join("") : node.alt ?? "";
        const url = definitions.get(node.identifier);
        return !url || label === url ? label : label ? `${label} (${url})` : url;
      }
      case "definition": return "";
      case "list": return node.children.map((item, index) => `${node.ordered ? `${(node.start ?? 1) + index}.` : "•"} ${render(item)}`).join("\n");
      case "listItem": case "blockquote": return node.children.map(render).join("\n\n");
      default: return "children" in node ? node.children.map(render).join("") : "";
    }
  };
  const plain = tree.children.map(render).filter(Boolean).join("\n\n");
  return plain.replace(new RegExp(`${token}(\\d+)END`, "g"), (_match, index: string) => urls[Number(index)]!);
}
